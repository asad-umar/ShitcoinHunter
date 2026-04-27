/**
 * TelegramAlerter — all Telegram messages
 *
 * Every trade message includes:
 *   - Mode-appropriate chart link (pump.fun for PF, DexScreener for GRD)
 *   - Token contract address as copyable code block
 *   - Paper vs real execution tag
 *   - Scanner mode tag (PF / GRD)
 */

import TelegramBot from 'node-telegram-bot-api';
import { Position, ScoredToken, TradeResult } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import type { ScannerMode, ExecutionMode } from '../modes/modeManager';

export class TelegramAlerter {
  private bot:         TelegramBot;
  private chatId:      string;
  private alertBot?:   TelegramBot;
  private alertChatId?: string;
  private scannerMode:   ScannerMode   = 'pf';
  private executionMode: ExecutionMode = 'paper';

  constructor() {
    this.bot    = new TelegramBot(config.telegram.botToken, { polling: false });
    this.chatId = config.telegram.chatId;

    if (config.telegram.alertBotToken && config.telegram.alertChatId) {
      this.alertBot    = new TelegramBot(config.telegram.alertBotToken, { polling: false });
      this.alertChatId = config.telegram.alertChatId;
    }
  }

  setModes(scanner: ScannerMode, execution: ExecutionMode): void {
    this.scannerMode   = scanner;
    this.executionMode = execution;
  }

  // ── Helpers ───────────────────────────────────────────
  private modeTag(): string {
    const exec    = this.executionMode === 'paper' ? '📄 PAPER' : '🟢 REAL';
    const scanner = this.scannerMode   === 'pf'    ? '🎪 PF'    : '🎓 GRD';
    return `${exec} | ${scanner}`;
  }

  private chartLink(scored: ScoredToken): string {
    const { token, onChain } = scored;
    if (this.scannerMode === 'pf') {
      return `<a href="https://pump.fun/${token.mintAddress}">📊 pump.fun chart</a>`;
    }
    return `<a href="${onChain.dexscreenerUrl}">📊 DexScreener chart</a>`;
  }

  private mintLine(mintAddress: string): string {
    return `📋 <b>Contract:</b> <code>${mintAddress}</code>`;
  }

  private sentimentEmoji(sentiment: string): string {
    const map: Record<string, string> = {
      moon: '🌕', hype: '🔥', neutral: '😐',
      sus: '👀',  rug: '💀',  dead: '🪦',
    };
    return map[sentiment] ?? '❓';
  }

  // ── Signal alert ──────────────────────────────────────
  async sendSignalAlert(scored: ScoredToken): Promise<void> {
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

    await this.send(msg, this.alertBot, this.alertChatId);
  }

  // ── Buy alert ─────────────────────────────────────────
  async sendBuyAlert(position: Position, scored: ScoredToken): Promise<void> {
    const tpUsd = config.trading.takeProfitUsd;
    const slUsd = config.trading.stopLossUsd;

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
      `⏱ Auto-exit: ${config.trading.maxHoldMinutes} min`,
      txLine,
      '',
      this.chartLink(scored),
      this.mintLine(position.mintAddress),
    ].filter(Boolean).join('\n');

    await this.send(msg);
  }

  // ── Sell alert ────────────────────────────────────────
  async sendSellAlert(position: Position, result: TradeResult): Promise<void> {
    const pnl      = position.pnlPercent ?? 0;
    const pnlUsd   = position.pnlUsd     ?? 0;
    const pnlEmoji = pnl >= 0 ? '📈' : '📉';

    const reasonEmoji: Record<string, string> = {
      take_profit:       '🎯',
      stop_loss:         '🛑',
      timeout:           '⏰',
      manual:            '🖐',
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
  async sendRejectionAlert(
    token: { ticker: string; name: string; mintAddress: string },
    stage: string,
    reason: string,
    heuristicScore?: number,
  ): Promise<void> {
    const stageEmoji: Record<string, string> = {
      profanity:   '🤬',
      hard_filter: '🚫',
      heuristic:   '📉',
      grok_skip:   '🤖',
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
  async sendGrokRejectionAlert(
    token: { ticker: string; name: string; mintAddress: string },
    onChain: { liquidityUsd: number; marketCapUsd: number; dexscreenerUrl: string },
    action: string,
    reason: string,
    vibeScore: number,
    scamPct: number,
  ): Promise<void> {
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

  // ── Sent to Grok ─────────────────────────────────────
  async sendGrokQueueAlert(
    token:         { ticker: string; name: string; mintAddress: string },
    onChain:       { liquidityUsd: number; marketCapUsd: number; volumeUsd24h: number; holderCount: number; ageMinutes: number; dexscreenerUrl: string },
    heuristicScore: number,
  ): Promise<void> {
    const msg = [
      `🔍 <b>SENT TO GROK</b> — $${token.ticker}`,
      `<i>${this.modeTag()} | Heuristic: ${heuristicScore}/10</i>`,
      '',
      `💰 MCap: $${onChain.marketCapUsd.toFixed(0)} | Liq: $${onChain.liquidityUsd.toFixed(0)}`,
      `📈 Vol: $${onChain.volumeUsd24h.toFixed(0)} | Buys: ${onChain.holderCount} | Age: ${onChain.ageMinutes.toFixed(1)}m`,
      '',
      this.mintLine(token.mintAddress),
    ].join('\n');

    await this.send(msg);
  }

  async sendGrokResultAlert(
    token:    { ticker: string; mintAddress: string },
    onChain:  { liquidityUsd: number; marketCapUsd: number; volumeUsd24h: number; holderCount: number; ageMinutes: number },
    decision: { action: string; vibeScore: number; scamConfidencePercent: number; reasoning: string; oneLiner: string },
  ): Promise<void> {
    const actionEmoji = decision.action === 'BUY' ? '🟢' : decision.action === 'WATCHLIST' ? '👀' : '🔴';
    const msg = [
      `🔍 <b>GROK EVAL</b> — $${token.ticker}`,
      `<i>${this.modeTag()}</i>`,
      '',
      `💰 MCap: $${onChain.marketCapUsd.toFixed(0)} | Liq: $${onChain.liquidityUsd.toFixed(0)}`,
      `📈 Vol: $${onChain.volumeUsd24h.toFixed(0)} | Buys: ${onChain.holderCount} | Age: ${onChain.ageMinutes.toFixed(1)}m`,
      '',
      `${actionEmoji} <b>${decision.action}</b> | Vibe: ${decision.vibeScore}/10 | Scam: ${decision.scamConfidencePercent}%`,
      `<i>${decision.oneLiner}</i>`,
      '',
      this.mintLine(token.mintAddress),
    ].join('\n');

    await this.send(msg);
  }

  // ── Error ─────────────────────────────────────────────
  async sendError(message: string): Promise<void> {
    await this.send(`❌ <b>ERROR:</b> ${message}`);
  }

  async sendWsAlert(message: string): Promise<void> {
    const msg = [`⚠️ <b>WebSocket Alert</b>`, `<i>${this.modeTag()}</i>`, '', message].join('\n');
    await this.send(msg);
  }

  // ── Startup ───────────────────────────────────────────
  async sendStartup(walletAddress: string, solBalance: number): Promise<void> {
    const msg = [
      `🤖 <b>Solana Shitcoin Hunter Started</b>`,
      `<i>${this.modeTag()}</i>`,
      '',
      `👛 Wallet: <code>${walletAddress}</code>`,
      `💰 SOL Balance: ${solBalance.toFixed(4)} SOL`,
      `🎯 Vibe threshold: ${config.trading.minVibeScore}/10`,
      `💸 Max buy: $${config.trading.maxBuyUsd}`,
      `🎯 Take profit: $${config.trading.takeProfitUsd}`,
      `🛑 Stop loss: $${config.trading.stopLossUsd}`,
      `⏱ Max hold: ${config.trading.maxHoldMinutes} min`,
    ].join('\n');

    await this.send(msg);
  }

  // ── Cycle summary (one per 30s scan window) ──────────
  async sendCycleSummary(message: string): Promise<void> {
    await this.send(message);
  }

  async sendRaw(message: string): Promise<void> {
    await this.send(message);
  }

  // ── Internal send with chunking + retry ─────────────────
  // ECONNRESET and similar transient errors are retried up to 3 times
  // with exponential backoff before giving up.
  private async send(message: string, bot?: TelegramBot, chatId?: string): Promise<void> {
    const botToUse     = bot    ?? this.bot;
    const targetChatId = chatId ?? this.chatId;
    const MAX          = 4_000;
    const chunks       = message.length <= MAX
      ? [message]
      : message.match(/.{1,4000}/gs) ?? [message];

    for (const chunk of chunks) {
      await this.sendWithRetry(botToUse, targetChatId, chunk);
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
    }
  }

  private async sendWithRetry(
    bot:    TelegramBot,
    chatId: string,
    chunk:  string,
    maxAttempts = 3,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await bot.sendMessage(chatId, chunk, {
          parse_mode:               'HTML',
          disable_web_page_preview: false,
        });
        return;
      } catch (err: any) {
        const isTransient = err.message?.includes('ECONNRESET')
          || err.message?.includes('ETIMEDOUT')
          || err.message?.includes('ENOTFOUND')
          || err.code === 'EFATAL';

        if (isTransient && attempt < maxAttempts) {
          const delayMs = attempt * 1_000;
          logger.warn(`[Telegram] Transient error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms — ${err.message}`);
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          logger.error('Telegram send failed', { error: err.message });
          return;
        }
      }
    }
  }
}
