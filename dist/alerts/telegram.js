"use strict";
/**
 * TelegramAlerter — all Telegram messages
 *
 * Every trade message includes:
 *   - Mode-appropriate chart link (pump.fun for PF, DexScreener for GRD)
 *   - Token contract address as copyable code block
 *   - Paper vs real execution tag
 *   - Scanner mode tag (PF / GRD)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramAlerter = void 0;
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const config_1 = require("../config");
const logger_1 = require("../logger");
class TelegramAlerter {
    constructor() {
        this.scannerMode = 'pf';
        this.executionMode = 'paper';
        this.bot = new node_telegram_bot_api_1.default(config_1.config.telegram.botToken, { polling: false });
        this.chatId = config_1.config.telegram.chatId;
    }
    setModes(scanner, execution) {
        this.scannerMode = scanner;
        this.executionMode = execution;
    }
    // ── Helpers ───────────────────────────────────────────
    modeTag() {
        const exec = this.executionMode === 'paper' ? '📄 PAPER' : '🟢 REAL';
        const scanner = this.scannerMode === 'pf' ? '🎪 PF' : '🎓 GRD';
        return `${exec} | ${scanner}`;
    }
    chartLink(scored) {
        const { token, onChain } = scored;
        if (this.scannerMode === 'pf') {
            return `<a href="https://pump.fun/${token.mintAddress}">📊 pump.fun chart</a>`;
        }
        return `<a href="${onChain.dexscreenerUrl}">📊 DexScreener chart</a>`;
    }
    mintLine(mintAddress) {
        return `📋 <b>Contract:</b> <code>${mintAddress}</code>`;
    }
    sentimentEmoji(sentiment) {
        const map = {
            moon: '🌕', hype: '🔥', neutral: '😐',
            sus: '👀', rug: '💀', dead: '🪦',
        };
        return map[sentiment] ?? '❓';
    }
    // ── Signal alert ──────────────────────────────────────
    async sendSignalAlert(scored) {
        const { token, onChain, vibe } = scored;
        const flags = vibe.redFlags.length > 0
            ? `\n⚠️ <b>Red flags:</b> ${vibe.redFlags.join(', ')}`
            : '\n✅ No red flags';
        const kols = vibe.kolSpotted && vibe.kolNames.length > 0
            ? `\n🎯 <b>KOLs:</b> ${vibe.kolNames.join(', ')}`
            : '';
        const msg = [
            `🚨 <b>NEW SIGNAL</b> — $${token.ticker}`,
            `<i>${this.modeTag()}</i>`,
            '',
            `📊 <b>Vibe: ${vibe.vibeScore}/10</b> | Confidence: ${vibe.confidencePercent}%`,
            `${this.sentimentEmoji(vibe.sentiment)} ${vibe.sentiment.toUpperCase()} | ⚡ ${vibe.velocity}`,
            `💬 ~${vibe.rawMentionCount} X mentions${kols}`,
            '',
            `📖 ${vibe.narrative}`,
            `🧠 <i>${vibe.oneLiner}</i>${flags}`,
            '',
            `💰 Liq: $${onChain.liquidityUsd.toFixed(0)} | MCap: $${onChain.marketCapUsd.toFixed(0)}`,
            '',
            this.chartLink(scored),
            this.mintLine(token.mintAddress),
        ].join('\n');
        await this.send(msg);
    }
    // ── Buy alert ─────────────────────────────────────────
    async sendBuyAlert(position, scored) {
        const tpUsd = config_1.config.trading.takeProfitUsd;
        const slUsd = config_1.config.trading.stopLossUsd;
        const txLine = position.txBuy && position.txBuy !== 'PAPER_BUY'
            ? `\n🔗 <a href="https://solscan.io/tx/${position.txBuy}">View TX on Solscan</a>`
            : '';
        const msg = [
            `✅ <b>BUY</b> — $${position.ticker}`,
            `<i>${this.modeTag()}</i>`,
            '',
            `💸 Spent: $${position.amountUsdSpent.toFixed(2)} (~${position.amountSolSpent.toFixed(4)} SOL)`,
            `🪙 Tokens: ${position.tokenAmount.toLocaleString()}`,
            `💵 Entry: $${position.entryPriceUsd.toFixed(8)}`,
            `🎯 Take profit: $${tpUsd} position value`,
            `🛑 Stop loss: $${slUsd} position value`,
            `⏱ Auto-exit: ${config_1.config.trading.maxHoldMinutes} min`,
            txLine,
            '',
            this.chartLink(scored),
            this.mintLine(position.mintAddress),
        ].filter(Boolean).join('\n');
        await this.send(msg);
    }
    // ── Sell alert ────────────────────────────────────────
    async sendSellAlert(position, result) {
        const pnl = position.pnlPercent ?? 0;
        const pnlUsd = position.pnlUsd ?? 0;
        const pnlEmoji = pnl >= 0 ? '📈' : '📉';
        const reasonEmoji = {
            take_profit: '🎯',
            stop_loss: '🛑',
            timeout: '⏰',
            manual: '🖐',
            strategy_override: '🔄',
        };
        const txLine = result.txSignature && !result.txSignature.startsWith('PAPER')
            ? `\n🔗 <a href="https://solscan.io/tx/${result.txSignature}">View TX on Solscan</a>`
            : '';
        const msg = [
            `${reasonEmoji[position.exitReason ?? 'manual']} <b>SELL</b> — $${position.ticker}`,
            `<i>${this.modeTag()}</i>`,
            '',
            `Reason: <b>${(position.exitReason ?? 'manual').replace(/_/g, ' ').toUpperCase()}</b>`,
            `${pnlEmoji} PnL: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</b> (${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})`,
            `Entry: $${position.entryPriceUsd.toFixed(8)}`,
            `Exit:  $${position.exitPriceUsd?.toFixed(8) ?? '?'}`,
            txLine,
            '',
            this.mintLine(position.mintAddress),
        ].filter(Boolean).join('\n');
        await this.send(msg);
    }
    // ── Pre-filter rejection ──────────────────────────────
    async sendRejectionAlert(token, stage, reason, heuristicScore) {
        const stageEmoji = {
            profanity: '🤬',
            hard_filter: '🚫',
            heuristic: '📉',
            grok_skip: '🤖',
        };
        const emoji = stageEmoji[stage] ?? '❌';
        const scoreStr = heuristicScore !== undefined ? ` | Score: ${heuristicScore}/10` : '';
        const msg = [
            `${emoji} <b>REJECTED</b> — $${token.ticker}`,
            `<i>${this.modeTag()} | Stage: ${stage.replace('_', ' ').toUpperCase()}</i>`,
            '',
            `📛 <b>Reason:</b> ${reason}${scoreStr}`,
            '',
            this.mintLine(token.mintAddress),
        ].join('\n');
        await this.send(msg);
    }
    // ── Grok decision rejection (SKIP / scam block) ───────
    async sendGrokRejectionAlert(token, onChain, action, reason, vibeScore, scamPct) {
        const chartUrl = this.scannerMode === 'pf'
            ? `https://pump.fun/${token.mintAddress}`
            : onChain.dexscreenerUrl;
        const msg = [
            `🤖 <b>GROK SKIP</b> — $${token.ticker}`,
            `<i>${this.modeTag()}</i>`,
            '',
            `Decision: <b>${action}</b> | Vibe: ${vibeScore}/10 | Scam risk: ${scamPct}%`,
            `📛 ${reason}`,
            `💰 Liq: $${onChain.liquidityUsd.toFixed(0)} | MCap: $${onChain.marketCapUsd.toFixed(0)}`,
            '',
            `<a href="${chartUrl}">📊 Chart</a>`,
            this.mintLine(token.mintAddress),
        ].join('\n');
        await this.send(msg);
    }
    // ── Error ─────────────────────────────────────────────
    async sendError(message) {
        await this.send(`❌ <b>ERROR:</b> ${message}`);
    }
    // ── Startup ───────────────────────────────────────────
    async sendStartup(walletAddress, solBalance) {
        const msg = [
            `🤖 <b>Solana Shitcoin Hunter Started</b>`,
            `<i>${this.modeTag()}</i>`,
            '',
            `👛 Wallet: <code>${walletAddress}</code>`,
            `💰 SOL Balance: ${solBalance.toFixed(4)} SOL`,
            `🎯 Vibe threshold: ${config_1.config.trading.minVibeScore}/10`,
            `💸 Max buy: $${config_1.config.trading.maxBuyUsd}`,
            `🎯 Take profit: $${config_1.config.trading.takeProfitUsd}`,
            `🛑 Stop loss: $${config_1.config.trading.stopLossUsd}`,
            `⏱ Max hold: ${config_1.config.trading.maxHoldMinutes} min`,
        ].join('\n');
        await this.send(msg);
    }
    // ── Cycle summary (one per 30s scan window) ──────────
    async sendCycleSummary(message) {
        await this.send(message);
    }
    // ── Internal send with chunking ───────────────────────
    async send(message) {
        const MAX = 4000;
        const chunks = message.length <= MAX
            ? [message]
            : message.match(/.{1,4000}/gs) ?? [message];
        for (const chunk of chunks) {
            try {
                await this.bot.sendMessage(this.chatId, chunk, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: false, // allow chart previews
                });
                if (chunks.length > 1)
                    await new Promise((r) => setTimeout(r, 400));
            }
            catch (err) {
                logger_1.logger.error('Telegram send failed', { error: err.message });
            }
        }
    }
}
exports.TelegramAlerter = TelegramAlerter;
//# sourceMappingURL=telegram.js.map