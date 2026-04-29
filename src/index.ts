/**
 * Solana Shitcoin Hunter V4
 *
 * Scanner modes:   pf  (Pump.fun bonding curve, pre-graduation)
 *                  grd (Raydium, post-graduation)
 *
 * Execution modes: paper (simulated trades, no real SOL)
 *                  real  (live Jupiter swaps)
 *
 * CLI:  npm run dev -- --scanner=pf --execution=paper
 * ENV:  SCANNER_MODE=pf EXECUTION_MODE=paper
 */

import 'dotenv/config';
import fs from 'fs';
import EventEmitter from 'events';

import { resolveModes }        from './modes/modeManager';
import { PumpFunWsScanner, fetchPFTokenData, IPFScanner, WsHealth } from './scanner/pumpfunWs';
import { PumpPortalWsScanner } from './scanner/pumpportalWs';
import { RaydiumScanner }      from './scanner/raydium';
import { DataFilter }          from './scanner/datafilter';
import { GrokAgent }           from './agent/grokAgent';
import { ClaudeReflection }    from './agent/claudeReflection';
import { JupiterTrader }       from './trader/jupiter';
import { PositionManagerV2 }   from './trader/positionsV2';
import { TelegramAlerter }     from './alerts/telegram';
import { DailyReporter }       from './alerts/dailyReport';
import { WatchList }           from './monitor/watchlist';
import { TradeMemory }         from './memory/tradeMemory';
import { config, wsProvider, pfThresholds, grdThresholds } from './config';
import { logger }              from './logger';
import { NewToken, TokenOnChainData, ScoredToken } from './types';
import { OnChainFetcher } from './scanner/onchain';
import { appendEvaluation } from './database/evaluationLog';
import { runDailyRetro }    from './analysis/retroAnalyzer';

['logs', 'data', 'data/reflections'].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

class ShitcoinHunter {
  // ── Mode resolution ───────────────────────────────────
  private readonly modes = resolveModes();

  // ── Core services ─────────────────────────────────────
  private memory     = new TradeMemory();
  private grokAgent  = new GrokAgent(this.memory);
  private reflection = new ClaudeReflection();
  private trader     = new JupiterTrader();
  private alerter    = new TelegramAlerter();
  private reporter   = new DailyReporter();
  private watchList  = new WatchList();
  private startTime  = Date.now();
  // Mode-specific pre-filters — constructed with env-driven thresholds
  private pfFilter  = new DataFilter(pfThresholds);
  private grdFilter = new DataFilter(grdThresholds);
  private get preFilter() { return this.modes.isPF ? this.pfFilter : this.grdFilter; }
  private positionManager: PositionManagerV2;

  // ── Scanner (selected by mode + WS_PROVIDER) ─────────
  private pfScanner:  IPFScanner     | null = null;
  private grdScanner: RaydiumScanner | null = null;
  private lastScannerHealth: WsHealth | null = null;

  // ── Maturation / GRD evaluation queue ───────────────────
  // PF:  tokens wait a minimum age after arrival before full evaluation.
  // GRD: tokens wait 15 min (or GRD_QUEUE_INTERVAL_MINUTES) after migration,
  //      then evaluated against retention + main thresholds each interval.
  private matureQueue: Array<{
    token:           NewToken;
    initialData:     TokenOnChainData;   // initial event data — used as fallback only
    birthTime:       number;
    fetchAttempts:   number;
    weight:          number;
    retentionRuns:   number;
    weightAlertSent: boolean;
    evaluationRuns:  number;
  }> = [];
  private matureQueueMints = new Set<string>();
  private readonly MATURATION_MINUTES         = parseFloat(process.env.MATURATION_MINUTES          ?? '5');  // PF: min age before evaluation
  private readonly MATURE_PROCESS_MINUTES     = parseFloat(process.env.MATURE_PROCESS_MINUTES      ?? '5');  // PF: how often the queue processor runs
  private readonly GRD_QUEUE_INTERVAL_MINUTES = parseInt  (process.env.GRD_QUEUE_INTERVAL_MINUTES  ?? '5');  // GRD: evaluation interval (also min age)
  private readonly MATURE_QUEUE_CAP           = 200;   // drop oldest if queue exceeds this

  // ── Grok queue ────────────────────────────────────────
  private grokQueue: Array<{ token: NewToken; onChain: TokenOnChainData; queuedAt: number; investigateCount?: number }> = [];
  private grokQueueMints = new Set<string>();   // deduplication
  private grokProcessing = false;
  private readonly GROK_QUEUE_MAX     = 30;     // drop oldest if backlog exceeds this
  private readonly GROK_STALE_MS      = 90_000; // discard tokens queued > 90s ago
  private readonly GROK_BATCH_MAX     = 3;      // max tokens per single Grok call

  // ── Stats ─────────────────────────────────────────────
  private filterStats = { seen: 0, hardFail: 0, heuristicFail: 0, grokCalls: 0 };

  // ── Cycle rejection accumulator ───────────────────────
  // Collects all rejections during a scan cycle; flushed as one Telegram message
  private cycleRejections: Array<{ ticker: string; stage: string; reason: string }> = [];
  private cycleGrokSkips:  Array<{ ticker: string; action: string; vibeScore: number; scamPct: number; oneLiner: string }> = [];
  private cyclePassedCount = 0;
  private cycleSeenCount   = 0;
  private cycleSeenTickers: string[] = [];

  // ── SOL price (refreshed every 60s) ──────────────────
  private solPriceUsd = 150;

  constructor() {
    this.positionManager = new PositionManagerV2(
      this.trader, this.fetcher(), this.alerter, this.memory
    );
    this.alerter.setModes(this.modes.scanner, this.modes.execution);
  }

  // Return appropriate onchain fetcher depending on mode
  private fetcher() {
    if (this.modes.isPF) {
      const oc = new OnChainFetcher();
      return {
        getCurrentPriceUsd: (mint: string) => fetchPFTokenData(mint).then((d) => d?.priceUsd ?? null),
        fetchTokenData:     (mint: string) => fetchPFTokenData(mint),
        isRugged:           (data: TokenOnChainData) => oc.isRugged(data),
      } as any;
    } else {
      const rd = new RaydiumScanner();
      const oc = new OnChainFetcher();
      return {
        getCurrentPriceUsd: (mint: string) => rd.getCurrentPriceUsd(mint),
        fetchTokenData:     (mint: string) => rd.fetchRaydiumData(mint).then((r) => r?.onChain ?? null),
        isRugged:           (data: TokenOnChainData) => oc.isRugged(data),
      } as any;
    }
  }

  // ── Startup ───────────────────────────────────────────
  async start(): Promise<void> {
    logger.info('=== Solana Shitcoin Hunter V4 ===');
    logger.info(`Scanner: ${this.modes.scanner.toUpperCase()} | Execution: ${this.modes.execution.toUpperCase()}`);
    logger.info(`Strategy: ${this.memory.strategyMode} | Vibe threshold: ${this.memory.vibeThreshold}/10`);
    logger.info(`Limits: buy $${config.trading.maxBuyUsd} | TP $${config.trading.takeProfitUsd} | SL $${config.trading.stopLossUsd}`);

    await this.fetchSolPrice();
    const solBalance = await this.trader.getSolBalance();
    logger.info(`Wallet: ${this.trader.walletAddress} | ${solBalance.toFixed(4)} SOL (~$${(solBalance * this.solPriceUsd).toFixed(2)})`);

    // Restore any open positions that survived a previous crash/restart
    const restored = this.positionManager.loadPersistedPositions();

    await this.alerter.sendStartup(this.trader.walletAddress, solBalance);

    // Start scanner
    this.startScanner();

    // Position monitor
    this.positionManager.startMonitoring(10_000);

    // Maturation queue processor (PF + GRD)
    const matureInterval   = this.modes.isPF ? this.MATURE_PROCESS_MINUTES         : this.GRD_QUEUE_INTERVAL_MINUTES;
    const matureMinDisplay = this.modes.isPF ? this.MATURATION_MINUTES             : this.GRD_QUEUE_INTERVAL_MINUTES;
    logger.info(`[Mature] Token min age: ${matureMinDisplay} min | Queue check every: ${matureInterval} min`);
    setInterval(() => this.processMatureQueue(), matureInterval * 60_000);

    // Grok queue processor
    setInterval(() => this.processGrokQueue(), 3_000);

    // Cycle summary flush — one Telegram message every 30s summarising rejections
    setInterval(() => this.flushCycleSummary(), 5 * 60_000);

    // Watchlist recheck
    setInterval(() => this.recheckWatchlist(), 60_000);

    // SOL price refresh
    setInterval(() => this.fetchSolPrice(), 60_000);

    // Hourly summary
    setInterval(() => this.positionManager.printSummary(), 60 * 60 * 1_000);

    // Daily report
    this.scheduleDailyReport();

    if (config.health.heartbeatEnabled && config.health.heartbeatMinutes > 0) {
      logger.info(`[Health] Log heartbeat every ${config.health.heartbeatMinutes} minute(s)`);
      setInterval(() => this.sendHeartbeat(), config.health.heartbeatMinutes * 60_000);
      setInterval(() => this.checkWebsocketHealth(), 60_000);
    }

    logger.info('All systems running.');
  }

  // ── Cycle summary — one Telegram message per scan run ──
  private async flushCycleSummary(_unused?: number): Promise<void> {
    const rejections    = this.cycleRejections;
    const grokSkips     = this.cycleGrokSkips;
    const passedCount   = this.cyclePassedCount;
    const totalSeen     = this.cycleSeenCount;
    const seenTickers   = this.cycleSeenTickers;

    // Reset accumulators
    this.cycleRejections   = [];
    this.cycleGrokSkips    = [];
    this.cyclePassedCount  = 0;
    this.cycleSeenCount    = 0;
    this.cycleSeenTickers  = [];

    // Nothing to report
    if (rejections.length === 0 && grokSkips.length === 0 && totalSeen === 0) return;

    // Group pre-filter rejections by stage
    const byStage: Record<string, string[]> = {};
    for (const r of rejections) {
      const label = this.stageLabel(r.stage);
      if (!byStage[label]) byStage[label] = [];
      byStage[label].push(`$${r.ticker}`);
    }

    // Group Grok skips by action
    const byAction: Record<string, string[]> = {};
    for (const g of grokSkips) {
      const label = this.actionLabel(g.action);
      if (!byAction[label]) byAction[label] = [];
      byAction[label].push(`$${g.ticker} (${g.vibeScore}/10)`);
    }

    const seenLine = totalSeen > 0
      ? `Seen: ${totalSeen} (${seenTickers.map(t => `$${t}`).join(', ')}) | Passed to Grok: ${passedCount} | Rejected: ${rejections.length + grokSkips.length}`
      : `Seen: 0 | Passed to Grok: ${passedCount} | Rejected: ${rejections.length + grokSkips.length}`;

    const lines: string[] = [
      `🔍 <b>Scan Cycle Complete</b>  <i>${this.modes.scanner.toUpperCase()} | ${this.modes.execution.toUpperCase()}</i>`,
      seenLine,
      '',
    ];

    if (Object.keys(byStage).length > 0) {
      lines.push('<b>Pre-filter rejections:</b>');
      for (const [label, tickers] of Object.entries(byStage)) {
        lines.push(`  ${label}: ${tickers.join(', ')}`);
      }
    }

    if (Object.keys(byAction).length > 0) {
      if (Object.keys(byStage).length > 0) lines.push('');
      lines.push('<b>Grok rejections:</b>');
      for (const [label, tickers] of Object.entries(byAction)) {
        lines.push(`  ${label}: ${tickers.join(', ')}`);
      }
    }

    if (passedCount > 0) {
      lines.push('');
      lines.push(`✅ ${passedCount} token(s) passed all filters and sent to Grok`);
    }

    await this.alerter.sendCycleSummary(lines.join('\n'));
  }

  private async sendHeartbeat(): Promise<void> {
    const uptimeMin = Math.floor((Date.now() - this.startTime) / 60_000);
    const lines = [
      `💓 <b>Heartbeat</b> — ${this.modes.scanner.toUpperCase()} | ${this.modes.execution.toUpperCase()}`,
      `Uptime: ${uptimeMin} minute(s)`,
      `Maturation queue: ${this.matureQueue.length} token(s)`,
      `Grok queue: ${this.grokQueue.length} token(s)`,
    ];

    const scannerHealth = this.modes.isPF
      ? this.pfScanner?.getHealth?.()
      : this.grdScanner?.getHealth?.();

    if (scannerHealth) {
      const lastMsg = scannerHealth.lastMessageMinutesAgo !== null
        ? `${scannerHealth.lastMessageMinutesAgo.toFixed(1)}m ago`
        : 'unknown';
      lines.push(`WS ${scannerHealth.source}: ${scannerHealth.wsConnected ? 'connected' : 'disconnected'} | last msg ${lastMsg} | reconnect ${Math.round(scannerHealth.reconnectDelay / 1000)}s`);
    }

    lines.push(`Seen this cycle: ${this.cycleSeenCount}`);
    lines.push(`Passed to Grok this cycle: ${this.cyclePassedCount}`);

    logger.info('[Health] Heartbeat log');
    logger.info(lines.join('\n'));
  }

  private async checkWebsocketHealth(): Promise<void> {
    const scannerHealth = this.modes.isPF
      ? this.pfScanner?.getHealth?.()
      : this.grdScanner?.getHealth?.();

    if (!scannerHealth) return;

    const staleThreshold = config.health.websocketStaleMinutes;
    const isStale = scannerHealth.lastMessageMinutesAgo !== null
      && scannerHealth.lastMessageMinutesAgo > staleThreshold;

    const prevLastMessage = this.lastScannerHealth?.lastMessageMinutesAgo;
    const wasStale = prevLastMessage !== null && prevLastMessage !== undefined
      && prevLastMessage > staleThreshold;

    const wasConnected = this.lastScannerHealth?.wsConnected ?? true;
    const connectionLost = this.lastScannerHealth !== null && wasConnected && !scannerHealth.wsConnected;
    const connectionRestored = this.lastScannerHealth !== null && !wasConnected && scannerHealth.wsConnected;
    const becameStale = this.lastScannerHealth !== null && !wasStale && isStale;

    if (connectionLost || connectionRestored || becameStale) {
      const lastMsg = scannerHealth.lastMessageMinutesAgo !== null
        ? `${scannerHealth.lastMessageMinutesAgo.toFixed(1)}m ago`
        : 'unknown';
      const lines = [
        `WS ${scannerHealth.source} state change`,
        `Connected: ${scannerHealth.wsConnected}`,
        `Last message: ${lastMsg}`,
        `Reconnect delay: ${Math.round(scannerHealth.reconnectDelay / 1000)}s`,
        `Stale threshold: ${staleThreshold}m`,
      ];

      if (connectionLost) lines.splice(1, 0, 'Reason: connection lost');
      if (connectionRestored) lines.splice(1, 0, 'Reason: connection restored');
      if (becameStale) lines.splice(1, 0, 'Reason: websocket stale');

      await this.alerter.sendWsAlert(lines.join('\n'));
    }

    this.lastScannerHealth = scannerHealth;
  }

  private stageLabel(stage: string): string {
    const map: Record<string, string> = {
      profanity:   '🤬 Profanity',
      hard_filter: '🚫 Liquidity / metrics',
      heuristic:   '📉 Low heuristic score',
      grok_skip:   '🤖 Grok skipped',
    };
    return map[stage] ?? stage;
  }

  private actionLabel(action: string): string {
    const map: Record<string, string> = {
      SKIP:        '🤖 Grok skip',
      SCAM_BLOCK:  '💀 Scam blocked',
      LOW_SCORE:   '📉 Score too low',
      WATCHLIST:   '👀 Watchlisted',
    };
    return map[action] ?? action;
  }

  // ── Scanner startup ───────────────────────────────────
  private startScanner(): void {
    if (this.modes.isPF) {
      if (wsProvider === 'pp') {
        logger.info('[Scanner] PF mode — PumpPortal WebSocket + REST fallback');
        this.pfScanner = new PumpPortalWsScanner();
      } else {
        logger.info('[Scanner] PF mode — Pump.fun WebSocket + REST fallback');
        this.pfScanner = new PumpFunWsScanner();
      }
      this.pfScanner.on('token', (token: NewToken, onChain: TokenOnChainData) => {
        this.processToken(token, onChain);
      });
      this.pfScanner.start();
    } else {
      logger.info('[Scanner] GRD mode — Raydium graduated token polling');
      this.grdScanner = new RaydiumScanner();
      this.grdScanner.on('token', (token: NewToken, onChain: TokenOnChainData) => {
        this.processToken(token, onChain);
      });
      this.grdScanner.start();
    }
  }

  // ── Token processing pipeline ─────────────────────────
  //
  // PF mode (two-stage):
  //   WS arrival → profanity check → maturation queue (wait X min)
  //   → fetch fresh on-chain data → metrics filter → Grok
  //
  // GRD mode (queued):
  //   Raydium graduation → queue → periodic evaluation every 15 min
  //   → fetch fresh Raydium on-chain data → metrics filter → Grok
  //
  private processToken(token: NewToken, onChain: TokenOnChainData): void {
    // Adjust liquidity/price with live SOL price (PF WS data uses SOL-denominated values)
    if (this.modes.isPF && (onChain as any).virtualSolReserves) {
      const vSol = (onChain as any).virtualSolReserves as number;
      onChain.liquidityUsd = vSol * 2 * this.solPriceUsd;
      onChain.priceUsd     = onChain.priceUsd * this.solPriceUsd;
    }

    this.filterStats.seen++;
    this.cycleSeenCount++;
    this.cycleSeenTickers.push(token.ticker);

    // ── Stage 0: Profanity — runs immediately for both modes ──
    const nameCheck = this.preFilter.evaluateName(token);
    if (!nameCheck.pass) {
      if (!this.modes.isPF) logger.info(`[GRD] ${token.name} (${token.mintAddress}) — rejected: profanity`);
      this.cycleRejections.push({ ticker: token.ticker, stage: nameCheck.stage, reason: nameCheck.reason });
      return;
    }

    const normalizedName = token.name.trim().toLowerCase();
    if (this.modes.isPF) {
      const existing = this.matureQueue.find(item => item.token.name.trim().toLowerCase() === normalizedName);
      if (existing) {
        existing.weight++;
        logger.info(`[Queue] $${token.ticker} — "${token.name}" duplicate name already queued, increased weight to ${existing.weight}`);

        return;
      }

      if (this.grokQueue.some(item => item.token.name.trim().toLowerCase() === normalizedName)) {
        logger.info(`[Queue] $${token.ticker} — "${token.name}" duplicate name already in Grok queue, discarding`);
        return;
      }
    }

    // ── All modes: park token in maturation queue ──
    // PF tokens wait for initial on-chain data to settle.
    // GRD tokens wait a minimum age after graduation before evaluation.
    if (this.matureQueueMints.has(token.mintAddress)) return;  // already queued

    // Enforce cap — drop oldest if full
    if (this.matureQueue.length >= this.MATURE_QUEUE_CAP) {
      const dropped = this.matureQueue.shift()!;
      this.matureQueueMints.delete(dropped.token.mintAddress);
      logger.warn(`[Mature] Queue cap (${this.MATURE_QUEUE_CAP}) reached — dropped oldest $${dropped.token.ticker}`);
    }

    this.matureQueue.push({ token, initialData: onChain, birthTime: Date.now(), fetchAttempts: 0, weight: 1, retentionRuns: 0, weightAlertSent: false, evaluationRuns: 0 });
    this.matureQueueMints.add(token.mintAddress);
    if (this.modes.isPF) {
      logger.debug(`[Queue] $${token.ticker} — "${token.name}" added to queue (weight=1, will evaluate in ${this.MATURATION_MINUTES}m | queue size: ${this.matureQueue.length})`);
    } else {
      logger.info(`[GRD] ${token.name} (${token.mintAddress}) — added to queue`);
    }
  }

  // ── Maturation queue processor — runs every 30s ───────
  private async processMatureQueue(): Promise<void> {
    if (this.matureQueue.length === 0) return;

    if (!this.modes.isPF) {
      logger.info(`[GRD] Maturation queue size: ${this.matureQueue.length}`);
    }

    const now          = Date.now();
    const maturationMs = this.modes.isPF
      ? this.MATURATION_MINUTES * 60_000
      : this.GRD_QUEUE_INTERVAL_MINUTES * 60_000;

    // Find tokens old enough to evaluate
    const ready = this.matureQueue.filter(item => (now - item.birthTime) >= maturationMs);
    if (ready.length === 0) return;

    let rejectedCount = 0;
    let retainedCount = 0;
    let forwardedCount = 0;
    const rejectedTokens: string[] = [];
    const retainedTokens: string[] = [];
    const forwardedTokens: string[] = [];

    logger.info(`[Queue] Maturation queue (${this.matureQueue.length} token(s)): ${this.matureQueue.map(i => `$${i.token.ticker}(w${i.weight})`).join(', ')}`);
    logger.info(`[Mature] ${ready.length} token(s) ready for evaluation`);

    for (const item of ready) {
      // Remove from queue
      this.matureQueue = this.matureQueue.filter(i => i.token.mintAddress !== item.token.mintAddress);
      this.matureQueueMints.delete(item.token.mintAddress);
      item.evaluationRuns++;

      const ageMin = (now - item.birthTime) / 60_000;

      // Fetch fresh on-chain data
      logger.debug(`[Mature] $${item.token.ticker} is ${ageMin.toFixed(1)}m old — fetching on-chain data`);
      let freshData: TokenOnChainData | null = null;
      try {
        if (this.modes.isPF) {
          freshData = await fetchPFTokenData(item.token.mintAddress);
        } else {
          const result = await this.grdScanner?.fetchRaydiumData(item.token.mintAddress) ?? null;
          if (result) {
            freshData = result.onChain;
            // Resolve name/ticker from DexScreener — migration events often lack them
            if (result.name && result.name !== 'Unknown') item.token.name   = result.name;
            if (result.symbol)                            item.token.ticker = result.symbol.toUpperCase();
          }
        }
      } catch {
        // will fall back below
      }

      if (!freshData) {
        item.fetchAttempts++;
        if (item.fetchAttempts < 3) {
          const nextFireMs = maturationMs + item.fetchAttempts * 10 * 60_000;
          item.birthTime   = now - nextFireMs + 10 * 60_000;
          retainedCount++;
          retainedTokens.push(`${item.token.ticker} (${item.token.mintAddress}) — fetch retry attempt ${item.fetchAttempts}`);
          this.matureQueue.push(item);
          this.matureQueueMints.add(item.token.mintAddress);
          continue;
        }
        rejectedCount++;
        const addressSuffix = item.evaluationRuns >= 2 ? ` (${item.token.mintAddress})` : '';
        rejectedTokens.push(`${item.token.ticker}${addressSuffix} — fetch failed after 3 attempts`);
        continue;
      }

      // ── GRD evaluation: retention thresholds → retain | main thresholds → Grok ──
      // ── PF evaluation: full metrics + heuristic pipeline ─────────────────────
      const result = this.modes.isPF
        ? this.preFilter.evaluateMetrics(item.token, freshData, item.retentionRuns)
        : this.grdFilter.evaluateGrdMetrics(item.token, freshData);

      if (result.outcome === 'retain') {
        item.retentionRuns++;
        retainedCount++;
        retainedTokens.push(`${item.token.ticker} (${item.token.mintAddress}) — iter ${item.retentionRuns}: ${result.reason}`);
        this.matureQueue.push(item);
        this.matureQueueMints.add(item.token.mintAddress);
        continue;
      }

      if (!result.pass) {
        rejectedCount++;
        const addressSuffix = item.evaluationRuns >= 2 ? ` (${item.token.mintAddress})` : '';
        rejectedTokens.push(`${item.token.ticker}${addressSuffix} — ${result.stage}: ${result.reason}`);
        continue;
      }

      if (this.modes.isPF) {
        // PF: run full metrics filter (includes heuristic) before Grok
        this.runMetricsFilter(item.token, freshData, item.weight, true);
      } else {
        // GRD: main thresholds already confirmed — enqueue directly for Grok
        this.filterStats.grokCalls++;
        this.cyclePassedCount++;
        logger.info(`[GRD] $${item.token.ticker} — passed metrics (iter ${item.evaluationRuns}, w${item.weight}) → queued for Grok`);
        this.enqueueForGrok(item.token, freshData);
      }
      forwardedCount++;
      forwardedTokens.push(`${item.token.ticker} (iter ${item.evaluationRuns}, w${item.weight})`);
    }

    if (rejectedCount > 0) {
      logger.info(`[Queue] Rejected Tokens (${rejectedCount} token(s)):\n${rejectedTokens.join('\n')}`);
    } else {
      logger.info(`[Queue] Rejected Tokens (${rejectedCount} token(s))`);
    }
    if (retainedCount > 0) {
      logger.info(`[Queue] Retained Tokens (${retainedCount} token(s)):\n${retainedTokens.join('\n')}`);
    } else {
      logger.info(`[Queue] Retained Tokens (${retainedCount} token(s))`);
    }
    if (forwardedCount > 0) {
      logger.info(`[Queue] Forwarded Tokens (${forwardedCount} token(s)):\n${forwardedTokens.join('\n')}`);
    } else {
      logger.info(`[Queue] Forwarded Tokens (${forwardedCount} token(s))`);
    }

    const remaining = this.matureQueue.map((item) => {
      const ageMin = ((now - item.birthTime) / 60_000).toFixed(1);
      return `$${item.token.ticker} w${item.weight} iter=${item.evaluationRuns} ` +
        `mcap=$${item.initialData.marketCapUsd.toFixed(0)} vol=$${item.initialData.volumeUsd24h.toFixed(0)} ` +
        `buys=${item.initialData.holderCount} age=${ageMin}m`;
    });
    if (remaining.length > 0) {
      logger.info(`[Queue] Remaining Maturation Queue (${remaining.length} token(s)):\n${remaining.join('\n')}`);
    } else {
      logger.info('[Queue] Remaining Maturation Queue (0 token(s))');
    }
  }

  // ── Stages 1 + 2: metrics filter → Grok queue ────────
  private runMetricsFilter(token: NewToken, onChain: TokenOnChainData, weight = 1, silent = false): boolean {
    const result = this.preFilter.evaluateMetrics(token, onChain);
    if (!result.pass) {
      if (result.stage === 'hard_filter') this.filterStats.hardFail++;
      else this.filterStats.heuristicFail++;
      this.cycleRejections.push({ ticker: token.ticker, stage: result.stage, reason: result.reason });
      if (!silent) logger.info(`[Eval] $${token.ticker} → DROPPED (${result.stage}): ${result.reason}`);
      return false;
    }

    this.filterStats.grokCalls++;
    this.cyclePassedCount++;
    if (!silent) logger.info(`[Eval] $${token.ticker} → PASSED filters (heuristic ${result.heuristicScore}/10, weight=${weight}) → queued for Grok`);
    this.enqueueForGrok(token, onChain);
    return true;
  }

  // ── Add a token to the Grok evaluation queue ─────────
  private enqueueForGrok(token: NewToken, onChain: TokenOnChainData, investigateCount = 0): void {
    if (this.grokQueueMints.has(token.mintAddress)) {
      logger.debug(`[Grok] $${token.ticker} already queued — skipping duplicate`);
      return;
    }
    if (this.grokQueue.length >= this.GROK_QUEUE_MAX) {
      const dropped = this.grokQueue.shift()!;
      this.grokQueueMints.delete(dropped.token.mintAddress);
      logger.warn(`[Grok] Queue full (${this.GROK_QUEUE_MAX}) — dropped stale $${dropped.token.ticker}`);
    }
    this.grokQueue.push({ token, onChain, queuedAt: Date.now(), investigateCount });
    this.grokQueueMints.add(token.mintAddress);
  }

  // ── Grok queue processor — drains all queued tokens in one batch call ──
  private async processGrokQueue(): Promise<void> {
    if (this.grokProcessing || this.grokQueue.length === 0) return;
    this.grokProcessing = true;

    try {
      // Drain the queue, dropping stale items, capping at GROK_BATCH_MAX
      const now   = Date.now();
      const batch: typeof this.grokQueue = [];

      while (this.grokQueue.length > 0 && batch.length < this.GROK_BATCH_MAX) {
        const item = this.grokQueue.shift()!;
        this.grokQueueMints.delete(item.token.mintAddress);

        const ageMs = now - item.queuedAt;
        if (ageMs > this.GROK_STALE_MS) {
          logger.warn(`[Grok] $${item.token.ticker} stale (${(ageMs / 1000).toFixed(0)}s) — discarding`);
          continue;
        }

        batch.push(item);
      }

      if (batch.length === 0) return;

      logger.info(
        `[Grok] Batch evaluating ${batch.length} token(s): ` +
        batch.map((i) => `$${i.token.ticker}`).join(', ')
      );

      const decisions = await this.grokAgent.evaluateBatch(
        batch.map((item) => ({ token: item.token, onChain: item.onChain }))
      );

      for (let i = 0; i < batch.length; i++) {
        const item     = batch[i];
        const decision = decisions[i];

        logger.info(
          `[Eval] $${item.token.ticker} → Grok: ${decision.action}` +
          ` | vibe ${decision.vibeScore}/10 | scam ${decision.scamConfidencePercent}%` +
          ` | "${decision.reasoning}"`
        );
        void this.alerter.sendGrokResultAlert(item.token, item.onChain, decision);

        const botAction =
          decision.action === 'BUY' && decision.scamConfidencePercent >= config.trading.maxScamConfidencePercent ? 'blocked_scam' :
          decision.action === 'BUY' && decision.vibeScore < this.memory.vibeThreshold                            ? 'blocked_score' :
          decision.action === 'BUY' && decision.confidencePercent < this.memory.confidenceThreshold              ? 'blocked_confidence' :
          decision.action === 'BUY' && decision.isDerivativePun                                                  ? 'blocked_pun' :
          decision.action === 'BUY' && decision.narrativeOriginality < 7                                         ? 'blocked_originality' :
          decision.action === 'BUY'                                                                               ? 'bought' :
          decision.action === 'WATCHLIST'                                                                         ? 'watchlisted' : 'skipped';

        appendEvaluation({
          evaluatedAt: new Date().toISOString(),
          mint:        item.token.mintAddress,
          ticker:      item.token.ticker,
          name:        item.token.name,
          mcapUsd:     item.onChain.marketCapUsd,
          volUsd:      item.onChain.volumeUsd24h,
          liqUsd:      item.onChain.liquidityUsd,
          holders:     item.onChain.holderCount,
          ageMinutes:  item.onChain.ageMinutes,
          grokAction:  decision.action,
          vibeScore:   decision.vibeScore,
          scamPct:     decision.scamConfidencePercent,
          reasoning:   decision.reasoning,
          oneLiner:    decision.oneLiner,
          botAction,
        });

        const scored: ScoredToken = {
          token:      item.token,
          onChain:    item.onChain,
          vibe:       decision,
          finalScore: decision.vibeScore,
          scoredAt:   new Date(),
        };

        await this.handleDecision(scored, item.investigateCount ?? 0);
      }
    } catch (err: any) {
      logger.error('Grok batch queue error', { error: err.message });
    } finally {
      this.grokProcessing = false;
    }
  }

  // ── Decision routing ──────────────────────────────────
  private async handleDecision(scored: ScoredToken, investigateCount = 0): Promise<void> {
    const { vibe, token } = scored;

    if (this.memory.strategyMode === 'paused') {
      logger.info(`[Decision] Strategy PAUSED — skip $${token.ticker}`);
      return;
    }

    switch (vibe.action) {
      case 'BUY':
        if (vibe.scamConfidencePercent > config.trading.maxScamConfidencePercent) {
          logger.info(`[Decision] BUY blocked — scam ${vibe.scamConfidencePercent}% for $${token.ticker}`);
          this.cycleGrokSkips.push({
            ticker:    token.ticker,
            action:    'SCAM_BLOCK',
            vibeScore: vibe.vibeScore,
            scamPct:   vibe.scamConfidencePercent,
            oneLiner:  `Scam risk ${vibe.scamConfidencePercent}%`,
          });
          return;
        }
        if (vibe.vibeScore < this.memory.vibeThreshold) {
          logger.info(`[Decision] BUY blocked — score ${vibe.vibeScore} < ${this.memory.vibeThreshold} for $${token.ticker}`);
          this.cycleGrokSkips.push({
            ticker:    token.ticker,
            action:    'LOW_SCORE',
            vibeScore: vibe.vibeScore,
            scamPct:   vibe.scamConfidencePercent,
            oneLiner:  `Score ${vibe.vibeScore}/10 below threshold`,
          });
          return;
        }
        logger.info(`[Decision] BUY $${token.ticker} — confidence ${vibe.confidencePercent}%`);
        await this.alerter.sendSignalAlert(scored);
        await this.executeBuy(scored);
        break;

      case 'WATCHLIST':
        logger.info(`[Decision] WATCHLIST $${token.ticker}`);
        this.watchList.add(scored);
        break;

      case 'INVESTIGATE':
        // Cap re-investigation at 2 attempts to prevent infinite loops
        if (investigateCount >= 2) {
          logger.info(`[Decision] INVESTIGATE cap reached for $${token.ticker} — treating as SKIP`);
          this.cycleGrokSkips.push({
            ticker:    token.ticker,
            action:    'SKIP',
            vibeScore: vibe.vibeScore,
            scamPct:   vibe.scamConfidencePercent,
            oneLiner:  'Investigate limit reached',
          });
          return;
        }
        logger.info(`[Decision] INVESTIGATE $${token.ticker} — re-queuing (attempt ${investigateCount + 1}/2)`);
        this.enqueueForGrok(scored.token, scored.onChain, investigateCount + 1);
        break;

      case 'SKIP':
      default:
        logger.debug(`[Decision] SKIP $${token.ticker}`);
        this.cycleGrokSkips.push({
          ticker:    token.ticker,
          action:    'SKIP',
          vibeScore: vibe.vibeScore,
          scamPct:   vibe.scamConfidencePercent,
          oneLiner:  vibe.oneLiner || 'No signal',
        });
    }
  }

  // ── Trade execution (paper vs real) ──────────────────
  private async executeBuy(scored: ScoredToken): Promise<void> {
    if (this.modes.isPaper) {
      // Paper mode — simulate the position without touching Jupiter
      await this.positionManager.openPaperPosition(scored, this.solPriceUsd);
    } else {
      await this.positionManager.openPosition(scored, this.solPriceUsd);
    }
  }

  // ── Watchlist recheck ─────────────────────────────────
  private async recheckWatchlist(): Promise<void> {
    const due = this.watchList.getDue();
    if (due.length === 0) return;

    logger.info(`[Watchlist] Rechecking ${due.length} tokens...`);
    for (const scored of due) {
      // Re-fetch fresh on-chain data from the appropriate source
      let fresh: TokenOnChainData | null = null;
      if (this.modes.isPF && this.pfScanner) {
        fresh = await this.pfScanner.fetchPFData(scored.token.mintAddress);
      } else if (this.grdScanner) {
        fresh = await this.grdScanner.fetchRaydiumData(scored.token.mintAddress).then((r) => r?.onChain ?? null);
      }

      if (!fresh) {
        this.watchList.remove(scored.token.mintAddress);
        continue;
      }
      if (!this.grokQueueMints.has(scored.token.mintAddress) && this.grokQueue.length < this.GROK_QUEUE_MAX) {
        this.grokQueue.push({ token: scored.token, onChain: fresh, queuedAt: Date.now() });
        this.grokQueueMints.add(scored.token.mintAddress);
      }
    }
  }

  // ── SOL price ─────────────────────────────────────────
  private async fetchSolPrice(): Promise<void> {
    try {
      const { default: axios } = await import('axios');
      const res = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { timeout: 5_000 }
      );
      const price = res.data?.solana?.usd;
      if (price && typeof price === 'number') {
        this.solPriceUsd = price;
        this.pfScanner?.updateSolPrice(price);
        logger.debug(`SOL price: $${price}`);
      }
    } catch {
      logger.warn(`[Price] Using cached SOL price $${this.solPriceUsd}`);
    }
  }

  // ── Daily report + reflection ─────────────────────────
  private scheduleDailyReport(): void {
    const run = async () => {
      logger.info('[Daily] Running report + Opus reflection...');
      const today  = this.memory.getTodayTrades();
      const all    = this.memory.getAllTrades();
      const date   = new Date().toISOString().slice(0, 10);

      // Run evaluation retrospective in parallel with Opus reflection
      const [reflection, retro] = await Promise.all([
        this.reflection.runDailyReflection(today, all, {
          vibeThreshold:       this.memory.vibeThreshold,
          confidenceThreshold: this.memory.confidenceThreshold,
          strategyMode:        this.memory.strategyMode,
          consecutiveLosses:   this.memory.consecutiveLosses,
          totalPnlUsd:         this.memory.totalPnlUsd,
        }),
        runDailyRetro(date),
      ]);

      // Apply retro vibe adjustment (additive on top of Opus recommendation)
      const thresholdDelta = (reflection?.recommendedThresholdChange ?? 0) + retro.vibeThresholdDelta;
      this.memory.applyReflectionRecommendation(
        thresholdDelta,
        reflection?.recommendedStrategyMode ?? this.memory.strategyMode,
        date,
      );

      await this.reporter.sendDailyTradeReport(today, reflection, {
        vibeThreshold: this.memory.vibeThreshold,
        strategyMode:  this.memory.strategyMode,
        totalPnlUsd:   this.memory.totalPnlUsd,
      });

      // Send retro report as a separate Telegram message
      await this.alerter.sendRaw(retro.telegramText);
    };

    const msUntilMidnight = () => {
      const now  = new Date();
      const next = new Date(now);
      next.setUTCHours(23, 59, 0, 0);
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime() - now.getTime();
    };

    const schedule = () => setTimeout(async () => { await run(); schedule(); }, msUntilMidnight());
    schedule();
    logger.info(`[Daily] Next report in ${(msUntilMidnight() / 3_600_000).toFixed(1)}h`);
  }
}

// ── Entry point ───────────────────────────────────────
async function main() {
  const hunter = new ShitcoinHunter();

  process.on('SIGINT',  () => { logger.info('Shutting down...'); process.exit(0); });
  process.on('unhandledRejection', (r) => logger.error('Unhandled rejection', { reason: r }));

  await hunter.start();
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
