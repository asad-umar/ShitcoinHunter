"use strict";
/**
 * PositionManagerV2 — USD-denominated position management
 *
 * Rules:
 *   - Buy:            never spend more than $10 per position
 *   - Take profit:    sell when position value hits $20
 *   - Trailing stop:  once above entry, trail by TRAIL_PCT (default 25%)
 *                     e.g. peaks at $18 → stop fires at $13.50
 *   - Hard stop loss: sell if value drops below $5 (catches slow bleeds before rally)
 *   - Timeout:        sell after MAX_HOLD_MINUTES regardless
 *
 * Fixes applied:
 *   - openPaperPosition moved inside class (was accidentally outside)
 *   - PnL now computed from actual Jupiter swap output, not price ratio
 *   - solPriceUsd stored at open so paper close uses consistent pricing
 *   - Trailing stop replaces static stop loss for positions that run green
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PositionManagerV2 = void 0;
const crypto_1 = require("crypto");
const config_1 = require("../config");
const logger_1 = require("../logger");
// Trailing stop: once position peaks above entry+5%, a pullback of this % triggers exit
const TRAIL_PCT = 0.25; // 25% pullback from high-water mark
class PositionManagerV2 {
    constructor(trader, fetcher, alerter, memory) {
        this.trader = trader;
        this.fetcher = fetcher;
        this.alerter = alerter;
        this.memory = memory;
        this.positions = new Map();
        this.vibeAtEntry = new Map();
        // Store sol price at open so paper-mode close uses the same reference
        this.solPriceAtOpen = new Map();
        this.monitorInterval = null;
    }
    // ── Open a real position ──────────────────────────────
    async openPosition(scored, solPriceUsd) {
        const { token, onChain, vibe } = scored;
        if (this.memory.strategyMode === 'paused') {
            logger_1.logger.warn(`[Positions] Strategy PAUSED — skipping $${token.ticker}`);
            return null;
        }
        if (this.openPositions.length >= config_1.config.trading.maxOpenPositions) {
            logger_1.logger.warn(`[Positions] Max open positions — skipping $${token.ticker}`);
            return null;
        }
        if (this.positions.has(token.mintAddress)) {
            logger_1.logger.warn(`[Positions] Already in $${token.ticker}`);
            return null;
        }
        const maxBuyUsd = config_1.config.trading.maxBuyUsd;
        const amountSol = maxBuyUsd / solPriceUsd;
        logger_1.logger.info(`[Positions] Opening $${token.ticker}: ` +
            `$${maxBuyUsd} (~${amountSol.toFixed(4)} SOL @ $${solPriceUsd.toFixed(2)}/SOL)`);
        const result = await this.trader.buy(token.mintAddress, amountSol);
        if (!result.success) {
            logger_1.logger.error(`[Positions] Buy failed: ${result.error}`);
            await this.alerter.sendError(`Buy FAILED $${token.ticker}: ${result.error}`);
            return null;
        }
        const position = {
            id: (0, crypto_1.randomUUID)(),
            mintAddress: token.mintAddress,
            ticker: token.ticker,
            entryPriceUsd: onChain.priceUsd,
            entryPriceSol: amountSol / Math.max(1, result.amountOut),
            amountUsdSpent: maxBuyUsd,
            amountSolSpent: amountSol,
            tokenAmount: result.amountOut,
            openedAt: new Date(),
            status: 'open',
            txBuy: result.txSignature,
            highWaterMarkUsd: maxBuyUsd,
        };
        this.positions.set(token.mintAddress, position);
        this.vibeAtEntry.set(token.mintAddress, vibe);
        this.solPriceAtOpen.set(token.mintAddress, solPriceUsd);
        await this.alerter.sendBuyAlert(position, scored);
        logger_1.logger.info(`[Positions] Opened: $${token.ticker}`, {
            entryUsd: onChain.priceUsd,
            tokensReceived: result.amountOut,
            tpAt: `$${config_1.config.trading.takeProfitUsd}`,
            slAt: `$${config_1.config.trading.stopLossUsd}`,
            trailPct: `${TRAIL_PCT * 100}%`,
        });
        return position;
    }
    // ── Open a paper (simulated) position ─────────────────
    async openPaperPosition(scored, solPriceUsd) {
        const { token, onChain, vibe } = scored;
        if (this.memory.strategyMode === 'paused')
            return null;
        if (this.openPositions.length >= config_1.config.trading.maxOpenPositions)
            return null;
        if (this.positions.has(token.mintAddress))
            return null;
        const maxBuyUsd = config_1.config.trading.maxBuyUsd;
        const amountSol = maxBuyUsd / solPriceUsd;
        const tokenAmount = onChain.priceUsd > 0 ? maxBuyUsd / onChain.priceUsd : 0;
        logger_1.logger.info(`[Paper] Simulated BUY $${token.ticker}: $${maxBuyUsd} @ $${onChain.priceUsd.toFixed(8)}`);
        const position = {
            id: (0, crypto_1.randomUUID)(),
            mintAddress: token.mintAddress,
            ticker: token.ticker,
            entryPriceUsd: onChain.priceUsd,
            entryPriceSol: amountSol / Math.max(1, tokenAmount),
            amountUsdSpent: maxBuyUsd,
            amountSolSpent: amountSol,
            tokenAmount,
            openedAt: new Date(),
            status: 'open',
            txBuy: 'PAPER_BUY',
            highWaterMarkUsd: maxBuyUsd,
        };
        this.positions.set(token.mintAddress, position);
        this.vibeAtEntry.set(token.mintAddress, vibe);
        this.solPriceAtOpen.set(token.mintAddress, solPriceUsd);
        await this.alerter.sendBuyAlert(position, scored);
        return position;
    }
    // ── Close a position ──────────────────────────────────
    async closePosition(mintAddress, reason, currentPriceUsd) {
        const position = this.positions.get(mintAddress);
        if (!position || position.status !== 'open')
            return;
        logger_1.logger.info(`[Positions] Closing $${position.ticker} — reason: ${reason}`);
        const isPaper = position.txBuy === 'PAPER_BUY';
        const solPriceAtOpen = this.solPriceAtOpen.get(mintAddress) ?? 150;
        let actualSolReceived = 0;
        if (isPaper) {
            // Paper mode: simulate proceeds = tokenAmount * currentPrice (in USD) / solPrice
            actualSolReceived = (position.tokenAmount * currentPriceUsd) / solPriceAtOpen;
        }
        else {
            const result = await this.trader.sellAll(mintAddress);
            if (!result.success) {
                logger_1.logger.error(`[Positions] Sell FAILED for $${position.ticker}: ${result.error}`);
                await this.alerter.sendError(`Sell FAILED $${position.ticker}: ${result.error}`);
                // Don't mark closed — will retry on next monitor cycle
                return;
            }
            position.txSell = result.txSignature;
            // result.amountOut is real SOL received from the Jupiter swap
            actualSolReceived = result.amountOut;
        }
        // Convert actual SOL received → USD using the price locked at open
        const exitValueUsd = actualSolReceived * solPriceAtOpen;
        position.status = 'closed';
        position.exitReason = reason;
        position.exitPriceUsd = currentPriceUsd;
        position.pnlUsd = exitValueUsd - position.amountUsdSpent;
        position.pnlPercent = (position.pnlUsd / position.amountUsdSpent) * 100;
        this.positions.set(mintAddress, position);
        const vibe = this.vibeAtEntry.get(mintAddress);
        if (vibe)
            this.memory.recordTrade(position, vibe);
        await this.alerter.sendSellAlert(position, {
            success: true,
            amountIn: position.tokenAmount,
            amountOut: actualSolReceived,
        });
        logger_1.logger.info(`[Positions] Closed $${position.ticker}: ` +
            `PnL ${position.pnlPercent.toFixed(1)}% ($${position.pnlUsd.toFixed(2)}) | ${reason}`);
        // Cleanup side-maps
        this.vibeAtEntry.delete(mintAddress);
        this.solPriceAtOpen.delete(mintAddress);
    }
    // ── Position monitor ──────────────────────────────────
    startMonitoring(intervalMs = 10000) {
        logger_1.logger.info(`[Positions] Monitor started — ` +
            `TP=$${config_1.config.trading.takeProfitUsd}, SL=$${config_1.config.trading.stopLossUsd}, ` +
            `Trail=${TRAIL_PCT * 100}% from peak`);
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
                logger_1.logger.error(`[Positions] Monitor error for $${position.ticker}`, { error: err.message });
            }
        }
    }
    async evaluatePosition(position) {
        const currentPriceUsd = await this.fetcher.getCurrentPriceUsd(position.mintAddress);
        if (!currentPriceUsd || currentPriceUsd <= 0) {
            logger_1.logger.warn(`[Positions] No price for $${position.ticker}`);
            return;
        }
        const currentValueUsd = position.entryPriceUsd > 0
            ? (currentPriceUsd / position.entryPriceUsd) * position.amountUsdSpent
            : position.amountUsdSpent;
        const ageMinutes = (Date.now() - position.openedAt.getTime()) / 60000;
        // Update high-water mark
        if (currentValueUsd > (position.highWaterMarkUsd ?? position.amountUsdSpent)) {
            position.highWaterMarkUsd = currentValueUsd;
            this.positions.set(position.mintAddress, position);
        }
        const hwm = position.highWaterMarkUsd ?? position.amountUsdSpent;
        logger_1.logger.info(`[$${position.ticker}] value: $${currentValueUsd.toFixed(2)} | ` +
            `hwm: $${hwm.toFixed(2)} | age: ${ageMinutes.toFixed(1)}m`);
        // ── TAKE PROFIT ───────────────────────────────────
        if (currentValueUsd >= config_1.config.trading.takeProfitUsd) {
            logger_1.logger.info(`[Positions] TAKE PROFIT $${position.ticker} @ $${currentValueUsd.toFixed(2)}`);
            await this.closePosition(position.mintAddress, 'take_profit', currentPriceUsd);
            return;
        }
        // ── TRAILING STOP ─────────────────────────────────
        // Only activates once the position has moved at least 5% above cost basis
        const trailingStopLevel = hwm * (1 - TRAIL_PCT);
        const positionRanGreen = hwm > position.amountUsdSpent * 1.05;
        if (positionRanGreen && currentValueUsd <= trailingStopLevel) {
            logger_1.logger.info(`[Positions] TRAILING STOP $${position.ticker}: ` +
                `$${currentValueUsd.toFixed(2)} fell below trail level $${trailingStopLevel.toFixed(2)} ` +
                `(peak was $${hwm.toFixed(2)})`);
            await this.closePosition(position.mintAddress, 'trailing_stop', currentPriceUsd);
            return;
        }
        // ── HARD STOP LOSS ────────────────────────────────
        // Catches slow bleeds on positions that never ran green
        if (currentValueUsd <= config_1.config.trading.stopLossUsd) {
            logger_1.logger.info(`[Positions] STOP LOSS $${position.ticker} @ $${currentValueUsd.toFixed(2)}`);
            await this.closePosition(position.mintAddress, 'stop_loss', currentPriceUsd);
            return;
        }
        // ── TIMEOUT ───────────────────────────────────────
        if (ageMinutes >= config_1.config.trading.maxHoldMinutes) {
            logger_1.logger.info(`[Positions] TIMEOUT $${position.ticker} held ${ageMinutes.toFixed(1)}m`);
            await this.closePosition(position.mintAddress, 'timeout', currentPriceUsd);
            return;
        }
        // ── STRATEGY OVERRIDE ─────────────────────────────
        if (this.memory.strategyMode === 'paused') {
            logger_1.logger.info(`[Positions] STRATEGY OVERRIDE: exiting $${position.ticker}`);
            await this.closePosition(position.mintAddress, 'strategy_override', currentPriceUsd);
            return;
        }
    }
    // ── Accessors ─────────────────────────────────────────
    get openPositions() {
        return Array.from(this.positions.values()).filter((p) => p.status === 'open');
    }
    get allPositions() {
        return Array.from(this.positions.values());
    }
    printSummary() {
        const all = this.allPositions;
        const closed = all.filter((p) => p.status === 'closed');
        logger_1.logger.info('=== POSITION SUMMARY ===');
        logger_1.logger.info(`Open: ${this.openPositions.length} | Closed: ${closed.length}`);
        logger_1.logger.info(`Memory: ${this.memory.getSummary()}`);
        for (const p of all) {
            logger_1.logger.info(`  [${p.status.toUpperCase()}] $${p.ticker} | ` +
                `${p.exitReason ?? 'holding'} | ` +
                `PnL: ${p.pnlPercent?.toFixed(1) ?? '?'}% ($${p.pnlUsd?.toFixed(2) ?? '?'})`);
        }
    }
}
exports.PositionManagerV2 = PositionManagerV2;
//# sourceMappingURL=positionsV2.js.map