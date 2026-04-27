/**
 * DailyReport — sends all trades performed today to Telegram (item 7)
 * Also sends the Opus reflection summary
 */

import TelegramBot from 'node-telegram-bot-api';
import { TradeRecord, DailyReflection, MemoryState } from '../types';
import { config } from '../config';
import { logger } from '../logger';

export class DailyReporter {
  private bot: TelegramBot;
  private chatId: string;

  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
    this.chatId = config.telegram.chatId;
  }

  async sendDailyTradeReport(
    trades: TradeRecord[],
    reflection: DailyReflection | null,
    memoryState: {
      vibeThreshold: number;
      strategyMode: MemoryState['strategyMode'];
      totalPnlUsd: number;
    },
  ): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);

    if (trades.length === 0) {
      await this.send(`📊 <b>Daily Report — ${date}</b>\n\nNo trades executed today.`);
      return;
    }

    const wins = trades.filter((t) => t.pnlUsd > 0);
    const losses = trades.filter((t) => t.pnlUsd <= 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
    const winRate = (wins.length / trades.length) * 100;

    const exitMap: Record<string, string> = {
      take_profit:       '🎯 TP',
      stop_loss:         '🛑 SL',
      trailing_stop:     '📉 Trail',
      timeout:           '⏰ TO',
      manual:            '🖐 MN',
      strategy_override: '🔄 SO',
    };

    const paperTrades = trades.filter((t) => t.isPaper);
    const realTrades  = trades.filter((t) => !t.isPaper);

    const formatTradeList = (list: TradeRecord[], startIndex: number): string =>
      list.map((t, i) => {
        const pnlEmoji = t.pnlUsd >= 0 ? '📈' : '📉';
        const pnlSign  = t.pnlPercent >= 0 ? '+' : '';
        const modeTag  = t.isPaper ? '📄' : '🟢';
        return (
          `${startIndex + i + 1}. ${modeTag} ${pnlEmoji} <b>$${t.ticker}</b> — ${exitMap[t.exitReason] ?? t.exitReason}\n` +
          `   PnL: <b>${pnlSign}${t.pnlPercent.toFixed(1)}%</b> (${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)})\n` +
          `   Entry: $${t.entryPriceUsd.toFixed(6)} → Exit: $${t.exitPriceUsd.toFixed(6)}\n` +
          `   Score: ${t.vibeScoreAtEntry}/10 | Conf: ${t.confidenceAtEntry}% | KOL: ${t.kolSpotted ? '✅' : '❌'}\n` +
          `   <i>${t.narrative}</i>`
        );
      }).join('\n\n');

    // ── Build trade list section ──────────────────────
    const tradeSections: string[] = [];

    if (paperTrades.length > 0) {
      const paperPnl = paperTrades.reduce((s, t) => s + t.pnlUsd, 0);
      const paperWins = paperTrades.filter((t) => t.pnlUsd > 0).length;
      tradeSections.push(
        `<b>📄 Paper Trades (${paperTrades.length}) — ${paperWins}W/${paperTrades.length - paperWins}L — ${paperPnl >= 0 ? '+' : ''}$${paperPnl.toFixed(2)}</b>`,
        '',
        formatTradeList(paperTrades, 0),
      );
    }

    if (realTrades.length > 0) {
      const realPnl  = realTrades.reduce((s, t) => s + t.pnlUsd, 0);
      const realWins  = realTrades.filter((t) => t.pnlUsd > 0).length;
      tradeSections.push(
        `<b>🟢 Real Trades (${realTrades.length}) — ${realWins}W/${realTrades.length - realWins}L — ${realPnl >= 0 ? '+' : ''}$${realPnl.toFixed(2)}</b>`,
        '',
        formatTradeList(realTrades, paperTrades.length),
      );
    }

    const summaryMsg = [
      `📊 <b>Daily Trade Report — ${date}</b>`,
      '',
      `Total: ${trades.length} trades | ✅ ${wins.length} | ❌ ${losses.length}`,
      `Win rate: ${winRate.toFixed(0)}%`,
      `Today PnL: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>`,
      `All-time PnL: $${memoryState.totalPnlUsd.toFixed(2)}`,
      `Mode: ${this.modeLabel(paperTrades.length, realTrades.length)}`,
      '',
      '<b>━━ Trades ━━</b>',
      '',
      tradeSections.join('\n\n'),
    ].join('\n');

    await this.send(summaryMsg);

    // ── Reflection summary (separate message if reflection ran) ───
    if (reflection) {
      await this.sendReflectionSummary(reflection, memoryState);
    }
  }

  private async sendReflectionSummary(
    r: DailyReflection,
    state: { vibeThreshold: number; strategyMode: string },
  ): Promise<void> {
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

  private modeLabel(paperCount: number, realCount: number): string {
    if (paperCount > 0 && realCount > 0) return `📄 Paper + 🟢 Real`;
    if (paperCount > 0) return `📄 Paper only`;
    return `🟢 Real only`;
  }

  private async send(message: string): Promise<void> {
    // Telegram has a 4096 char limit per message — chunk if needed
    const MAX = 4000;
    if (message.length <= MAX) {
      try {
        await this.bot.sendMessage(this.chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      } catch (err: any) {
        logger.error('[DailyReport] Telegram send failed', { error: err.message });
      }
      return;
    }

    // Split into chunks
    const chunks: string[] = [];
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
      } catch (err: any) {
        logger.error('[DailyReport] Telegram chunk send failed', { error: err.message });
      }
    }
  }
}
