"use strict";
/**
 * DailyReport — sends all trades performed today to Telegram (item 7)
 * Also sends the Opus reflection summary
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DailyReporter = void 0;
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const config_1 = require("../config");
const logger_1 = require("../logger");
class DailyReporter {
    constructor() {
        this.bot = new node_telegram_bot_api_1.default(config_1.config.telegram.botToken, { polling: false });
        this.chatId = config_1.config.telegram.chatId;
    }
    async sendDailyTradeReport(trades, reflection, memoryState) {
        const date = new Date().toISOString().slice(0, 10);
        if (trades.length === 0) {
            await this.send(`📊 <b>Daily Report — ${date}</b>\n\nNo trades executed today.`);
            return;
        }
        const wins = trades.filter((t) => t.pnlUsd > 0);
        const losses = trades.filter((t) => t.pnlUsd <= 0);
        const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
        const winRate = (wins.length / trades.length) * 100;
        // ── Trade list ────────────────────────────────────
        const tradeLines = trades
            .map((t, i) => {
            const pnlEmoji = t.pnlUsd >= 0 ? '📈' : '📉';
            const pnlSign = t.pnlPercent >= 0 ? '+' : '';
            const exitMap = {
                take_profit: '🎯 TP',
                stop_loss: '🛑 SL',
                timeout: '⏰ TO',
                manual: '🖐 MN',
                strategy_override: '🔄 SO',
            };
            return (`${i + 1}. ${pnlEmoji} <b>$${t.ticker}</b> — ${exitMap[t.exitReason] ?? t.exitReason}\n` +
                `   PnL: <b>${pnlSign}${t.pnlPercent.toFixed(1)}%</b> ($${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)})\n` +
                `   Entry: $${t.entryPriceUsd.toFixed(6)} → Exit: $${t.exitPriceUsd.toFixed(6)}\n` +
                `   Score: ${t.vibeScoreAtEntry}/10 | Confidence: ${t.confidenceAtEntry}% | KOL: ${t.kolSpotted ? '✅' : '❌'}\n` +
                `   <i>${t.narrative}</i>`);
        })
            .join('\n\n');
        const summaryMsg = [
            `📊 <b>Daily Trade Report — ${date}</b>`,
            '',
            `Trades: ${trades.length} | ✅ ${wins.length} | ❌ ${losses.length}`,
            `Win rate: ${winRate.toFixed(0)}%`,
            `Today PnL: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>`,
            `All-time PnL: $${memoryState.totalPnlUsd.toFixed(2)}`,
            '',
            '<b>━━ Trades ━━</b>',
            '',
            tradeLines,
        ].join('\n');
        await this.send(summaryMsg);
        // ── Reflection summary (separate message if reflection ran) ───
        if (reflection) {
            await this.sendReflectionSummary(reflection, memoryState);
        }
    }
    async sendReflectionSummary(r, state) {
        const thresholdIcon = r.recommendedThresholdChange > 0 ? '⬆️' : r.recommendedThresholdChange < 0 ? '⬇️' : '➡️';
        const learningLines = r.keyLearnings.map((l, i) => `${i + 1}. ${l}`).join('\n');
        const msg = [
            `🧠 <b>Opus Daily Reflection — ${r.date}</b>`,
            '',
            `<b>Assessment:</b> ${r.strategyAssessment}`,
            '',
            `<b>Patterns:</b> ${r.patternInsights}`,
            '',
            `<b>Key learnings:</b>`,
            learningLines,
            '',
            `<b>Tomorrow's focus:</b> ${r.tomorrowFocus}`,
            '',
            `<b>Adjustments applied:</b>`,
            `  Threshold: ${thresholdIcon} ${r.recommendedThresholdChange > 0 ? '+' : ''}${r.recommendedThresholdChange} → now ${state.vibeThreshold}/10`,
            `  Strategy mode: → <b>${r.recommendedStrategyMode}</b>`,
        ].join('\n');
        await this.send(msg);
    }
    async send(message) {
        // Telegram has a 4096 char limit per message — chunk if needed
        const MAX = 4000;
        if (message.length <= MAX) {
            try {
                await this.bot.sendMessage(this.chatId, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
            }
            catch (err) {
                logger_1.logger.error('[DailyReport] Telegram send failed', { error: err.message });
            }
            return;
        }
        // Split into chunks
        const chunks = [];
        let remaining = message;
        while (remaining.length > 0) {
            chunks.push(remaining.slice(0, MAX));
            remaining = remaining.slice(MAX);
        }
        for (const chunk of chunks) {
            try {
                await this.bot.sendMessage(this.chatId, chunk, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                });
                await new Promise((r) => setTimeout(r, 500)); // rate limit
            }
            catch (err) {
                logger_1.logger.error('[DailyReport] Telegram chunk send failed', { error: err.message });
            }
        }
    }
}
exports.DailyReporter = DailyReporter;
//# sourceMappingURL=dailyReport.js.map