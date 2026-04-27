/**
 * PositionManagerV2 — USD-denominated position management with disk persistence
 *
 * Open positions are written to data/positions.json the moment a buy executes.
 * On restart, any open positions are restored so monitoring continues uninterrupted.
 * When a sell closes a position, the same record is updated in-place with exit
 * price, P&L, and exit reason — giving a complete ledger in one file.
 *
 * Rules:
 *   - Buy:            never spend more than $10 per position
 *   - Take profit:    sell when position value hits $20
 *   - Trailing stop:  once above entry, trail by TRAIL_PCT (default 25%)
 *                     e.g. peaks at $18 → stop fires at $13.50
 *   - Hard stop loss: sell if value drops below $5 (catches slow bleeds before rally)
 *   - Timeout:        sell after MAX_HOLD_MINUTES regardless
 */

import fs from 'fs';
import path from 'path';
import { randomUUID as uuidv4 } from 'crypto';
import { Position, ScoredToken, TradeResult, AgentDecision } from '../types';
import { JupiterTrader } from './jupiter';
import { OnChainFetcher } from '../scanner/onchain';
import { TelegramAlerter } from '../alerts/telegram';
import { TradeMemory } from '../memory/tradeMemory';
import { config } from '../config';
import { logger } from '../logger';

// Trailing stop: once position peaks above entry+5%, a pullback of this % triggers exit
const TRAIL_PCT = 0.25;

// ── Persistence types ─────────────────────────────────────────────────────────
interface PersistedEntry {
  position:      Position;
  vibe:          AgentDecision;
  solPriceAtOpen: number;
}

interface PositionsFile {
  positions: PersistedEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────

export class PositionManagerV2 {
  private positions      = new Map<string, Position>();
  private vibeAtEntry    = new Map<string, AgentDecision>();
  private solPriceAtOpen = new Map<string, number>();
  private monitorInterval: NodeJS.Timeout | null = null;

  private readonly POSITIONS_FILE = 'data/positions.json';

  constructor(
    private trader:  JupiterTrader,
    private fetcher: OnChainFetcher,
    private alerter: TelegramAlerter,
    private memory:  TradeMemory,
  ) {
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.POSITIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // ── Restore open positions on startup ────────────────
  loadPersistedPositions(): number {
    try {
      if (!fs.existsSync(this.POSITIONS_FILE)) return 0;

      const raw  = fs.readFileSync(this.POSITIONS_FILE, 'utf-8');
      const data = JSON.parse(raw) as PositionsFile;

      let loaded = 0;

      for (const entry of data.positions ?? []) {
        if (entry.position.status !== 'open') continue;

        // JSON serialises Date as string — restore the object
        entry.position.openedAt = new Date(entry.position.openedAt);

        this.positions.set(entry.position.mintAddress, entry.position);
        this.vibeAtEntry.set(entry.position.mintAddress, entry.vibe);
        this.solPriceAtOpen.set(entry.position.mintAddress, entry.solPriceAtOpen);

        logger.info(
          `[Positions] Restored open position: $${entry.position.ticker} ` +
          `| entry $${entry.position.entryPriceUsd.toFixed(8)} ` +
          `| ${entry.position.txBuy === 'PAPER_BUY' ? 'PAPER' : 'REAL'}`
        );

        loaded++;
      }

      if (loaded > 0) {
        logger.info(`[Positions] ${loaded} open position(s) restored from disk — monitoring resumed`);
      }

      return loaded;
    } catch (err: any) {
      logger.error('[Positions] Failed to load persisted positions', { error: err.message });
      return 0;
    }
  }

  // ── Write / update a position in the file ────────────
  private persistPosition(mintAddress: string): void {
    try {
      const position      = this.positions.get(mintAddress);
      const vibe          = this.vibeAtEntry.get(mintAddress);
      const solPriceAtOpen = this.solPriceAtOpen.get(mintAddress) ?? 150;

      if (!position) return;

      // Read current file (or start fresh)
      let data: PositionsFile = { positions: [] };
      if (fs.existsSync(this.POSITIONS_FILE)) {
        try {
          data = JSON.parse(fs.readFileSync(this.POSITIONS_FILE, 'utf-8'));
        } catch {
          data = { positions: [] };
        }
      }

      const entry: PersistedEntry = {
        position,
        vibe:          vibe ?? {} as AgentDecision,
        solPriceAtOpen,
      };

      // Update existing record or append
      const idx = data.positions.findIndex((e) => e.position.id === position.id);
      if (idx >= 0) {
        data.positions[idx] = entry;
      } else {
        data.positions.push(entry);
      }

      fs.writeFileSync(this.POSITIONS_FILE, JSON.stringify(data, null, 2));
    } catch (err: any) {
      logger.error(`[Positions] Failed to persist position for ${mintAddress}`, { error: err.message });
    }
  }

  // ── Open a real position ──────────────────────────────
  async openPosition(scored: ScoredToken, solPriceUsd: number): Promise<Position | null> {
    const { token, onChain, vibe } = scored;

    if (this.memory.strategyMode === 'paused') {
      logger.warn(`[Positions] Strategy PAUSED — skipping $${token.ticker}`);
      return null;
    }
    if (this.openPositions.length >= config.trading.maxOpenPositions) {
      logger.warn(`[Positions] Max open positions — skipping $${token.ticker}`);
      return null;
    }
    if (this.positions.has(token.mintAddress)) {
      logger.warn(`[Positions] Already in $${token.ticker}`);
      return null;
    }

    const maxBuyUsd = config.trading.maxBuyUsd;
    const amountSol = maxBuyUsd / solPriceUsd;

    logger.info(
      `[Positions] Opening $${token.ticker}: ` +
      `$${maxBuyUsd} (~${amountSol.toFixed(4)} SOL @ $${solPriceUsd.toFixed(2)}/SOL)`
    );

    const result: TradeResult = await this.trader.buy(token.mintAddress, amountSol);

    if (!result.success) {
      logger.error(`[Positions] Buy failed: ${result.error}`);
      await this.alerter.sendError(`Buy FAILED $${token.ticker}: ${result.error}`);
      return null;
    }

    const position: Position = {
      id:               uuidv4(),
      mintAddress:      token.mintAddress,
      ticker:           token.ticker,
      entryPriceUsd:    onChain.priceUsd,
      entryPriceSol:    amountSol / Math.max(1, result.amountOut),
      amountUsdSpent:   maxBuyUsd,
      amountSolSpent:   amountSol,
      tokenAmount:      result.amountOut,
      openedAt:         new Date(),
      status:           'open',
      txBuy:            result.txSignature,
      highWaterMarkUsd: maxBuyUsd,
    };

    this.positions.set(token.mintAddress, position);
    this.vibeAtEntry.set(token.mintAddress, vibe);
    this.solPriceAtOpen.set(token.mintAddress, solPriceUsd);

    // Persist immediately so a crash doesn't lose the open position
    this.persistPosition(token.mintAddress);

    logger.info(`[Positions] Sending Telegram BUY alert for $${token.ticker} (REAL)`);
    await this.alerter.sendBuyAlert(position, scored);
    logger.info(`[Positions] Opened: $${token.ticker}`, {
      entryUsd:       onChain.priceUsd,
      tokensReceived: result.amountOut,
      tpAt:           `$${config.trading.takeProfitUsd}`,
      slAt:           `$${config.trading.stopLossUsd}`,
      trailPct:       `${TRAIL_PCT * 100}%`,
    });

    return position;
  }

  // ── Open a paper (simulated) position ─────────────────
  async openPaperPosition(scored: ScoredToken, solPriceUsd: number): Promise<Position | null> {
    const { token, onChain, vibe } = scored;

    if (this.memory.strategyMode === 'paused') return null;
    if (this.openPositions.length >= config.trading.maxOpenPositions) return null;
    if (this.positions.has(token.mintAddress)) return null;

    const maxBuyUsd   = config.trading.maxBuyUsd;
    const amountSol   = maxBuyUsd / solPriceUsd;
    const tokenAmount = onChain.priceUsd > 0 ? maxBuyUsd / onChain.priceUsd : 0;

    logger.info(`[Paper] Simulated BUY $${token.ticker}: $${maxBuyUsd} @ $${onChain.priceUsd.toFixed(8)}`);

    const position: Position = {
      id:               uuidv4(),
      mintAddress:      token.mintAddress,
      ticker:           token.ticker,
      entryPriceUsd:    onChain.priceUsd,
      entryPriceSol:    amountSol / Math.max(1, tokenAmount),
      amountUsdSpent:   maxBuyUsd,
      amountSolSpent:   amountSol,
      tokenAmount,
      openedAt:         new Date(),
      status:           'open',
      txBuy:            'PAPER_BUY',
      highWaterMarkUsd: maxBuyUsd,
    };

    this.positions.set(token.mintAddress, position);
    this.vibeAtEntry.set(token.mintAddress, vibe);
    this.solPriceAtOpen.set(token.mintAddress, solPriceUsd);

    // Persist immediately so a crash doesn't lose the open position
    this.persistPosition(token.mintAddress);

    logger.info(`[Positions] Sending Telegram BUY alert for $${token.ticker} (PAPER)`);
    await this.alerter.sendBuyAlert(position, scored);
    return position;
  }

  // ── Close a position ──────────────────────────────────
  async closePosition(
    mintAddress:     string,
    reason:          Position['exitReason'],
    currentPriceUsd: number,
  ): Promise<void> {
    const position = this.positions.get(mintAddress);
    if (!position || position.status !== 'open') return;

    logger.info(`[Positions] Closing $${position.ticker} — reason: ${reason}`);

    const isPaper        = position.txBuy === 'PAPER_BUY';
    const solPriceAtOpen = this.solPriceAtOpen.get(mintAddress) ?? 150;
    let actualSolReceived = 0;

    if (isPaper) {
      // Paper mode: simulate proceeds = tokenAmount * currentPrice (in USD) / solPrice
      actualSolReceived = (position.tokenAmount * currentPriceUsd) / solPriceAtOpen;
    } else {
      const result = await this.trader.sellAll(mintAddress);

      if (!result.success) {
        logger.error(`[Positions] Sell FAILED for $${position.ticker}: ${result.error}`);
        await this.alerter.sendError(`Sell FAILED $${position.ticker}: ${result.error}`);
        // Don't mark closed — will retry on next monitor cycle
        return;
      }

      position.txSell   = result.txSignature;
      actualSolReceived = result.amountOut;
    }

    // ── Calculate P&L ─────────────────────────────────
    const exitValueUsd    = actualSolReceived * solPriceAtOpen;
    position.status       = 'closed';
    position.exitReason   = reason;
    position.exitPriceUsd = currentPriceUsd;
    position.pnlUsd       = exitValueUsd - position.amountUsdSpent;
    position.pnlPercent   = (position.pnlUsd / position.amountUsdSpent) * 100;

    this.positions.set(mintAddress, position);

    // ── Update the persisted record with final close details ──
    // Must happen before vibeAtEntry is cleaned up (persistPosition reads it)
    this.persistPosition(mintAddress);

    // ── Record to memory.json (drives adaptive thresholds + daily report) ──
    const vibe = this.vibeAtEntry.get(mintAddress);
    if (vibe) this.memory.recordTrade(position, vibe);

    logger.info(`[Positions] Sending Telegram SELL alert for $${position.ticker} (${isPaper ? 'PAPER' : 'REAL'}) — PnL ${position.pnlPercent?.toFixed(1)}% ($${position.pnlUsd?.toFixed(2)})`);
    await this.alerter.sendSellAlert(position, {
      success:   true,
      amountIn:  position.tokenAmount,
      amountOut: actualSolReceived,
    });

    logger.info(
      `[Positions] Closed $${position.ticker}: ` +
      `PnL ${position.pnlPercent.toFixed(1)}% ($${position.pnlUsd.toFixed(2)}) | ${reason}`
    );

    // Cleanup side-maps
    this.vibeAtEntry.delete(mintAddress);
    this.solPriceAtOpen.delete(mintAddress);
  }

  // ── Position monitor ──────────────────────────────────
  startMonitoring(intervalMs = 10_000): void {
    logger.info(
      `[Positions] Monitor started — ` +
      `TP=$${config.trading.takeProfitUsd}, SL=$${config.trading.stopLossUsd}, ` +
      `Trail=${TRAIL_PCT * 100}% from peak`
    );
    this.monitorInterval = setInterval(() => this.checkPositions(), intervalMs);
  }

  stopMonitoring(): void {
    if (this.monitorInterval) clearInterval(this.monitorInterval);
  }

  private async checkPositions(): Promise<void> {
    const open = this.openPositions;
    if (open.length === 0) return;

    for (const position of open) {
      try {
        await this.evaluatePosition(position);
      } catch (err: any) {
        logger.error(`[Positions] Monitor error for $${position.ticker}`, { error: err.message });
      }
    }
  }

  private async evaluatePosition(position: Position): Promise<void> {
    const currentPriceUsd = await this.fetcher.getCurrentPriceUsd(position.mintAddress);

    if (!currentPriceUsd || currentPriceUsd <= 0) {
      logger.warn(`[Positions] No price for $${position.ticker}`);
      return;
    }

    const currentValueUsd = position.entryPriceUsd > 0
      ? (currentPriceUsd / position.entryPriceUsd) * position.amountUsdSpent
      : position.amountUsdSpent;

    const ageMinutes = (Date.now() - position.openedAt.getTime()) / 60_000;

    // Update high-water mark
    if (currentValueUsd > (position.highWaterMarkUsd ?? position.amountUsdSpent)) {
      position.highWaterMarkUsd = currentValueUsd;
      this.positions.set(position.mintAddress, position);
    }

    const hwm = position.highWaterMarkUsd ?? position.amountUsdSpent;

    logger.info(
      `[$${position.ticker}] value: $${currentValueUsd.toFixed(2)} | ` +
      `hwm: $${hwm.toFixed(2)} | age: ${ageMinutes.toFixed(1)}m`
    );

    // ── TAKE PROFIT ───────────────────────────────────
    if (currentValueUsd >= config.trading.takeProfitUsd) {
      logger.info(`[Positions] TAKE PROFIT $${position.ticker} @ $${currentValueUsd.toFixed(2)}`);
      await this.closePosition(position.mintAddress, 'take_profit', currentPriceUsd);
      return;
    }

    // ── TRAILING STOP ─────────────────────────────────
    const trailingStopLevel = hwm * (1 - TRAIL_PCT);
    const positionRanGreen  = hwm > position.amountUsdSpent * 1.05;

    if (positionRanGreen && currentValueUsd <= trailingStopLevel) {
      logger.info(
        `[Positions] TRAILING STOP $${position.ticker}: ` +
        `$${currentValueUsd.toFixed(2)} fell below trail level $${trailingStopLevel.toFixed(2)} ` +
        `(peak was $${hwm.toFixed(2)})`
      );
      await this.closePosition(position.mintAddress, 'trailing_stop', currentPriceUsd);
      return;
    }

    // ── HARD STOP LOSS ────────────────────────────────
    if (currentValueUsd <= config.trading.stopLossUsd) {
      logger.info(`[Positions] STOP LOSS $${position.ticker} @ $${currentValueUsd.toFixed(2)}`);
      await this.closePosition(position.mintAddress, 'stop_loss', currentPriceUsd);
      return;
    }

    // ── TIMEOUT ───────────────────────────────────────
    if (ageMinutes >= config.trading.maxHoldMinutes) {
      logger.info(`[Positions] TIMEOUT $${position.ticker} held ${ageMinutes.toFixed(1)}m`);
      await this.closePosition(position.mintAddress, 'timeout', currentPriceUsd);
      return;
    }

    // ── STRATEGY OVERRIDE ─────────────────────────────
    if (this.memory.strategyMode === 'paused') {
      logger.info(`[Positions] STRATEGY OVERRIDE: exiting $${position.ticker}`);
      await this.closePosition(position.mintAddress, 'strategy_override', currentPriceUsd);
      return;
    }
  }

  // ── Accessors ─────────────────────────────────────────
  get openPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'open');
  }

  get allPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  printSummary(): void {
    const all    = this.allPositions;
    const closed = all.filter((p) => p.status === 'closed');
    logger.info('=== POSITION SUMMARY ===');
    logger.info(`Open: ${this.openPositions.length} | Closed: ${closed.length}`);
    logger.info(`Memory: ${this.memory.getSummary()}`);
    for (const p of all) {
      logger.info(
        `  [${p.status.toUpperCase()}] $${p.ticker} | ` +
        `${p.exitReason ?? 'holding'} | ` +
        `PnL: ${p.pnlPercent?.toFixed(1) ?? '?'}% ($${p.pnlUsd?.toFixed(2) ?? '?'})`
      );
    }
  }
}
