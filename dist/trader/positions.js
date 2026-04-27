"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionManager = void 0;
const crypto_1 = require("crypto");
const config_1 = require("../config");
const logger_1 = require("../logger");
class PositionManager {
    constructor(trader, fetcher, alerter) {
        this.positions = new Map();
        this.monitorInterval = null;
        this.trader = trader;
        this.fetcher = fetcher;
        this.alerter = alerter;
    }
    // ── Open a new position ──────────────────────────────
    async openPosition(scored) {
        const { token, onChain } = scored;
        // Safety checks
        if (this.openPositions.length >= config_1.config.trading.maxOpenPositions) {
            logger_1.logger.warn(`Max open positions reached (${config_1.config.trading.maxOpenPositions}), skipping ${token.ticker}`);
            return null;
        }
        const totalExposure = this.openPositions.reduce((sum, p) => sum + p.amountSolSpent, 0);
        if (totalExposure + config_1.config.trading.amountSol > config_1.config.trading.maxTotalExposureSol) {
            logger_1.logger.warn(`Max exposure reached, skipping ${token.ticker}`);
            return null;
        }
        // Don't double-buy the same token
        if (this.positions.has(token.mintAddress)) {
            logger_1.logger.warn(`Already have position in ${token.ticker}`);
            return null;
        }
        logger_1.logger.info(`Opening position: ${token.ticker} @ $${onChain.priceUsd}`);
        const result = await this.trader.buy(token.mintAddress, config_1.config.trading.amountSol);
        if (!result.success) {
            logger_1.logger.error(`Buy failed for ${token.ticker}: ${result.error}`);
            await this.alerter.sendError(`Buy FAILED for $${token.ticker}: ${result.error}`);
            return null;
        }
        const position = {
            id: (0, crypto_1.randomUUID)(),
            mintAddress: token.mintAddress,
            ticker: token.ticker,
            entryPriceSol: config_1.config.trading.amountSol / result.amountOut,
            entryPriceUsd: onChain.priceUsd,
            amountSolSpent: config_1.config.trading.amountSol,
            tokenAmount: result.amountOut,
            openedAt: new Date(),
            status: 'open',
            txBuy: result.txSignature,
        };
        this.positions.set(token.mintAddress, position);
        await this.alerter.sendBuyAlert(position, scored);
        logger_1.logger.info(`Position opened: ${token.ticker}`, position);
        return position;
    }
    // ── Close a position ─────────────────────────────────
    async closePosition(mintAddress, reason) {
        const position = this.positions.get(mintAddress);
        if (!position || position.status !== 'open')
            return;
        logger_1.logger.info(`Closing position: ${position.ticker} (${reason})`);
        const result = await this.trader.sellAll(mintAddress);
        const currentPrice = await this.fetcher.getCurrentPriceUsd(mintAddress);
        position.status = 'closed';
        position.exitReason = reason;
        position.exitPriceUsd = currentPrice ?? position.entryPriceUsd;
        position.txSell = result.txSignature;
        if (position.entryPriceUsd > 0 && position.exitPriceUsd) {
            position.pnlPercent =
                ((position.exitPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
            // Rough USD PnL based on SOL spent
            const solReceived = result.success ? result.amountOut : 0;
            position.pnlUsd = (solReceived - position.amountSolSpent) * (currentPrice ?? 1) * 20; // rough
        }
        this.positions.set(mintAddress, position);
        await this.alerter.sendSellAlert(position, result);
        if (!result.success) {
            logger_1.logger.error(`Sell FAILED for ${position.ticker}: ${result.error}`);
            // Don't remove — keep trying on next cycle
            position.status = 'open'; // reset so monitor retries
        }
    }
    // ── Position monitor loop ─────────────────────────────
    startMonitoring(intervalMs = 10000) {
        logger_1.logger.info('Position monitor started');
        this.monitorInterval = setInterval(() => this.checkPositions(), intervalMs);
    }
    stopMonitoring() {
        if (this.monitorInterval)
            clearInterval(this.monitorInterval);
    }
    async checkPositions() {
        const open = this.openPositions;
        if (open.length === 0)
            return;
        for (const position of open) {
            try {
                await this.evaluatePosition(position);
            }
            catch (err) {
                logger_1.logger.error(`Monitor error for ${position.ticker}`, { error: err.message });
            }
        }
    }
    async evaluatePosition(position) {
        const currentPrice = await this.fetcher.getCurrentPriceUsd(position.mintAddress);
        if (!currentPrice || currentPrice <= 0) {
            logger_1.logger.warn(`Could not fetch price for ${position.ticker}`);
            return;
        }
        const multiplier = currentPrice / position.entryPriceUsd;
        const ageMinutes = (Date.now() - position.openedAt.getTime()) / 60000;
        logger_1.logger.info(`[${position.ticker}] entry: $${position.entryPriceUsd.toFixed(8)} | current: $${currentPrice.toFixed(8)} | ${multiplier.toFixed(2)}x | age: ${ageMinutes.toFixed(1)}m`);
        // ── TAKE PROFIT ──────────────────────────────────
        if (multiplier >= config_1.config.trading.takeProfitMultiplier) {
            logger_1.logger.info(`TAKE PROFIT triggered for ${position.ticker} at ${multiplier.toFixed(2)}x`);
            await this.closePosition(position.mintAddress, 'take_profit');
            return;
        }
        // ── STOP LOSS ────────────────────────────────────
        if (multiplier <= config_1.config.trading.stopLossMultiplier) {
            logger_1.logger.info(`STOP LOSS triggered for ${position.ticker} at ${multiplier.toFixed(2)}x`);
            await this.closePosition(position.mintAddress, 'stop_loss');
            return;
        }
        // ── TIMEOUT ──────────────────────────────────────
        if (ageMinutes >= config_1.config.trading.maxHoldMinutes) {
            logger_1.logger.info(`TIMEOUT triggered for ${position.ticker} after ${ageMinutes.toFixed(1)} min`);
            await this.closePosition(position.mintAddress, 'timeout');
            return;
        }
    }
    get openPositions() {
        return Array.from(this.positions.values()).filter((p) => p.status === 'open');
    }
    get allPositions() {
        return Array.from(this.positions.values());
    }
    getPosition(mintAddress) {
        return this.positions.get(mintAddress);
    }
    printSummary() {
        const all = this.allPositions;
        const closed = all.filter((p) => p.status === 'closed');
        const totalPnl = closed.reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0);
        logger_1.logger.info('=== POSITION SUMMARY ===');
        logger_1.logger.info(`Open: ${this.openPositions.length} | Closed: ${closed.length}`);
        logger_1.logger.info(`Estimated PnL: $${totalPnl.toFixed(2)}`);
        for (const p of all) {
            logger_1.logger.info(`  [${p.status.toUpperCase()}] $${p.ticker} | ${p.exitReason ?? 'holding'} | PnL: ${p.pnlPercent?.toFixed(1) ?? '?'}%`);
        }
    }
}
exports.PositionManager = PositionManager;
//# sourceMappingURL=positions.js.map