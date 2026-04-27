"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fs_1 = __importDefault(require("fs"));
const modeManager_1 = require("./modes/modeManager");
const pumpfunWs_1 = require("./scanner/pumpfunWs");
const raydium_1 = require("./scanner/raydium");
const prefilter_1 = require("./scanner/prefilter");
const grokAgent_1 = require("./agent/grokAgent");
const claudeReflection_1 = require("./agent/claudeReflection");
const jupiter_1 = require("./trader/jupiter");
const positionsV2_1 = require("./trader/positionsV2");
const telegram_1 = require("./alerts/telegram");
const dailyReport_1 = require("./alerts/dailyReport");
const watchlist_1 = require("./monitor/watchlist");
const tradeMemory_1 = require("./memory/tradeMemory");
const config_1 = require("./config");
const logger_1 = require("./logger");
const onchain_1 = require("./scanner/onchain");
['logs', 'data', 'data/reflections'].forEach((d) => {
    if (!fs_1.default.existsSync(d))
        fs_1.default.mkdirSync(d, { recursive: true });
});
class ShitcoinHunter {
    constructor() {
        // ── Mode resolution ───────────────────────────────────
        this.modes = (0, modeManager_1.resolveModes)();
        // ── Core services ─────────────────────────────────────
        this.memory = new tradeMemory_1.TradeMemory();
        this.grokAgent = new grokAgent_1.GrokAgent(this.memory);
        this.reflection = new claudeReflection_1.ClaudeReflection();
        this.trader = new jupiter_1.JupiterTrader();
        this.alerter = new telegram_1.TelegramAlerter();
        this.reporter = new dailyReport_1.DailyReporter();
        this.watchList = new watchlist_1.WatchList();
        this.preFilter = new prefilter_1.PreFilter();
        // ── Scanner (selected by mode) ────────────────────────
        this.pfScanner = null;
        this.grdScanner = null;
        // ── Grok queue (rate-limited to 1 call / 3s) ─────────
        this.grokQueue = [];
        this.grokQueueMints = new Set(); // deduplication
        this.grokProcessing = false;
        this.GROK_QUEUE_MAX = 30; // drop oldest if backlog exceeds this
        this.GROK_STALE_MS = 90000; // discard tokens queued > 90s ago
        // ── Stats ─────────────────────────────────────────────
        this.filterStats = { seen: 0, hardFail: 0, heuristicFail: 0, grokCalls: 0 };
        // ── Cycle rejection accumulator ───────────────────────
        // Collects all rejections during a scan cycle; flushed as one Telegram message
        this.cycleRejections = [];
        this.cycleGrokSkips = [];
        this.cyclePassedCount = 0;
        // ── SOL price (refreshed every 60s) ──────────────────
        this.solPriceUsd = 150;
        this.positionManager = new positionsV2_1.PositionManagerV2(this.trader, this.fetcher(), this.alerter, this.memory);
        this.alerter.setModes(this.modes.scanner, this.modes.execution);
    }
    // Return appropriate onchain fetcher depending on mode
    fetcher() {
        if (this.modes.isPF) {
            const pf = new pumpfunWs_1.PumpFunWsScanner();
            const oc = new onchain_1.OnChainFetcher();
            return {
                getCurrentPriceUsd: (mint) => pf.fetchPFData(mint).then((d) => d?.priceUsd ?? null),
                fetchTokenData: (mint) => pf.fetchPFData(mint),
                isRugged: (data) => oc.isRugged(data),
            };
        }
        else {
            const rd = new raydium_1.RaydiumScanner();
            const oc = new onchain_1.OnChainFetcher();
            return {
                getCurrentPriceUsd: (mint) => rd.getCurrentPriceUsd(mint),
                fetchTokenData: (mint) => rd.fetchRaydiumData(mint),
                isRugged: (data) => oc.isRugged(data),
            };
        }
    }
    // ── Startup ───────────────────────────────────────────
    async start() {
        logger_1.logger.info('=== Solana Shitcoin Hunter V4 ===');
        logger_1.logger.info(`Scanner: ${this.modes.scanner.toUpperCase()} | Execution: ${this.modes.execution.toUpperCase()}`);
        logger_1.logger.info(`Strategy: ${this.memory.strategyMode} | Vibe threshold: ${this.memory.vibeThreshold}/10`);
        logger_1.logger.info(`Limits: buy $${config_1.config.trading.maxBuyUsd} | TP $${config_1.config.trading.takeProfitUsd} | SL $${config_1.config.trading.stopLossUsd}`);
        await this.fetchSolPrice();
        const solBalance = await this.trader.getSolBalance();
        logger_1.logger.info(`Wallet: ${this.trader.walletAddress} | ${solBalance.toFixed(4)} SOL (~$${(solBalance * this.solPriceUsd).toFixed(2)})`);
        await this.alerter.sendStartup(this.trader.walletAddress, solBalance);
        // Start scanner
        this.startScanner();
        // Position monitor
        this.positionManager.startMonitoring(10000);
        // Grok queue processor
        setInterval(() => this.processGrokQueue(), 3000);
        // Cycle summary flush — one Telegram message every 30s summarising rejections
        setInterval(async () => {
            const seen = this.filterStats.seen;
            await this.flushCycleSummary(seen);
        }, 30000);
        // Watchlist recheck
        setInterval(() => this.recheckWatchlist(), 60000);
        // SOL price refresh
        setInterval(() => this.fetchSolPrice(), 60000);
        // Hourly summary
        setInterval(() => this.positionManager.printSummary(), 60 * 60 * 1000);
        // Daily report
        this.scheduleDailyReport();
        logger_1.logger.info('All systems running.');
    }
    // ── Cycle summary — one Telegram message per scan run ──
    async flushCycleSummary(totalSeen) {
        const rejections = this.cycleRejections;
        const grokSkips = this.cycleGrokSkips;
        const passedCount = this.cyclePassedCount;
        // Reset accumulators
        this.cycleRejections = [];
        this.cycleGrokSkips = [];
        this.cyclePassedCount = 0;
        // Nothing to report
        if (rejections.length === 0 && grokSkips.length === 0 && totalSeen === 0)
            return;
        // Group pre-filter rejections by stage
        const byStage = {};
        for (const r of rejections) {
            const label = this.stageLabel(r.stage);
            if (!byStage[label])
                byStage[label] = [];
            byStage[label].push(`$${r.ticker}`);
        }
        // Group Grok skips by action
        const byAction = {};
        for (const g of grokSkips) {
            const label = this.actionLabel(g.action);
            if (!byAction[label])
                byAction[label] = [];
            byAction[label].push(`$${g.ticker} (${g.vibeScore}/10)`);
        }
        const lines = [
            `🔍 <b>Scan Cycle Complete</b>  <i>${this.modes.scanner.toUpperCase()} | ${this.modes.execution.toUpperCase()}</i>`,
            `Seen: ${totalSeen} | Passed to Grok: ${passedCount} | Rejected: ${rejections.length + grokSkips.length}`,
            '',
        ];
        if (Object.keys(byStage).length > 0) {
            lines.push('<b>Pre-filter rejections:</b>');
            for (const [label, tickers] of Object.entries(byStage)) {
                lines.push(`  ${label}: ${tickers.join(', ')}`);
            }
        }
        if (Object.keys(byAction).length > 0) {
            if (Object.keys(byStage).length > 0)
                lines.push('');
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
    stageLabel(stage) {
        const map = {
            profanity: '🤬 Profanity',
            hard_filter: '🚫 Liquidity / metrics',
            heuristic: '📉 Low heuristic score',
            grok_skip: '🤖 Grok skipped',
        };
        return map[stage] ?? stage;
    }
    actionLabel(action) {
        const map = {
            SKIP: '🤖 Grok skip',
            SCAM_BLOCK: '💀 Scam blocked',
            LOW_SCORE: '📉 Score too low',
            WATCHLIST: '👀 Watchlisted',
        };
        return map[action] ?? action;
    }
    // ── Scanner startup ───────────────────────────────────
    startScanner() {
        if (this.modes.isPF) {
            logger_1.logger.info('[Scanner] PF mode — Pump.fun WebSocket + REST fallback');
            this.pfScanner = new pumpfunWs_1.PumpFunWsScanner();
            this.pfScanner.on('token', (token, onChain) => {
                this.processToken(token, onChain);
            });
            this.pfScanner.start();
        }
        else {
            logger_1.logger.info('[Scanner] GRD mode — Raydium graduated token polling');
            this.grdScanner = new raydium_1.RaydiumScanner();
            this.grdScanner.on('token', (token, onChain) => {
                this.processToken(token, onChain);
            });
            this.grdScanner.start();
        }
    }
    // ── Token processing pipeline ─────────────────────────
    processToken(token, onChain) {
        // Refresh liquidity calculation with real SOL price (PF mode)
        if (this.modes.isPF && onChain.virtualSolReserves) {
            const vSol = onChain.virtualSolReserves;
            onChain.liquidityUsd = vSol * 2 * this.solPriceUsd;
            // priceUsd from PF scanner is denominated in SOL terms; convert to USD
            // by multiplying by the live SOL price (no hardcoded baseline)
            onChain.priceUsd = onChain.priceUsd * this.solPriceUsd;
        }
        this.filterStats.seen++;
        const pre = this.preFilter.evaluate(token, onChain);
        if (!pre.pass) {
            if (pre.stage === 'hard_filter')
                this.filterStats.hardFail++;
            else
                this.filterStats.heuristicFail++;
            // Accumulate — will be sent as one summary at cycle end
            this.cycleRejections.push({
                ticker: token.ticker,
                stage: pre.stage,
                reason: pre.reason,
            });
            return;
        }
        this.filterStats.grokCalls++;
        this.cyclePassedCount++;
        // Deduplicate — skip if this mint is already queued
        if (this.grokQueueMints.has(token.mintAddress)) {
            logger_1.logger.debug(`[Queue] $${token.ticker} already queued — skipping duplicate`);
            return;
        }
        // Enforce queue cap — drop the oldest entry if full
        if (this.grokQueue.length >= this.GROK_QUEUE_MAX) {
            const dropped = this.grokQueue.shift();
            this.grokQueueMints.delete(dropped.token.mintAddress);
            logger_1.logger.warn(`[Queue] Queue full (${this.GROK_QUEUE_MAX}) — dropped stale $${dropped.token.ticker}`);
        }
        this.grokQueue.push({ token, onChain, queuedAt: Date.now() });
        this.grokQueueMints.add(token.mintAddress);
    }
    // ── Grok queue processor ──────────────────────────────
    async processGrokQueue() {
        if (this.grokProcessing || this.grokQueue.length === 0)
            return;
        this.grokProcessing = true;
        const item = this.grokQueue.shift();
        this.grokQueueMints.delete(item.token.mintAddress);
        // Staleness check — token data older than 90s is useless for memecoins
        const ageMs = Date.now() - item.queuedAt;
        if (ageMs > this.GROK_STALE_MS) {
            logger_1.logger.warn(`[Grok] $${item.token.ticker} stale (${(ageMs / 1000).toFixed(0)}s in queue) — discarding`);
            this.grokProcessing = false;
            void this.processGrokQueue(); // immediately drain next item rather than waiting for the 3s interval
            return;
        }
        try {
            logger_1.logger.info(`[Grok] Evaluating $${item.token.ticker}...`);
            const decision = await this.grokAgent.evaluate(item.token, item.onChain);
            logger_1.logger.info(`[Grok] $${item.token.ticker} → ${decision.action} | ` +
                `vibe:${decision.vibeScore}/10 | scam:${decision.scamConfidencePercent}%`);
            logger_1.logger.info(`  ${decision.reasoning}`);
            const scored = {
                token: item.token,
                onChain: item.onChain,
                vibe: decision,
                finalScore: decision.vibeScore,
                scoredAt: new Date(),
            };
            await this.handleDecision(scored, item.investigateCount ?? 0);
        }
        catch (err) {
            logger_1.logger.error(`Grok queue error for $${item.token.ticker}`, { error: err.message });
        }
        finally {
            this.grokProcessing = false;
        }
    }
    // ── Decision routing ──────────────────────────────────
    async handleDecision(scored, investigateCount = 0) {
        const { vibe, token } = scored;
        if (this.memory.strategyMode === 'paused') {
            logger_1.logger.info(`[Decision] Strategy PAUSED — skip $${token.ticker}`);
            return;
        }
        switch (vibe.action) {
            case 'BUY':
                if (vibe.scamConfidencePercent > config_1.config.trading.maxScamConfidencePercent) {
                    logger_1.logger.info(`[Decision] BUY blocked — scam ${vibe.scamConfidencePercent}% for $${token.ticker}`);
                    this.cycleGrokSkips.push({
                        ticker: token.ticker,
                        action: 'SCAM_BLOCK',
                        vibeScore: vibe.vibeScore,
                        scamPct: vibe.scamConfidencePercent,
                        oneLiner: `Scam risk ${vibe.scamConfidencePercent}%`,
                    });
                    return;
                }
                if (vibe.vibeScore < this.memory.vibeThreshold) {
                    logger_1.logger.info(`[Decision] BUY blocked — score ${vibe.vibeScore} < ${this.memory.vibeThreshold} for $${token.ticker}`);
                    this.cycleGrokSkips.push({
                        ticker: token.ticker,
                        action: 'LOW_SCORE',
                        vibeScore: vibe.vibeScore,
                        scamPct: vibe.scamConfidencePercent,
                        oneLiner: `Score ${vibe.vibeScore}/10 below threshold`,
                    });
                    return;
                }
                logger_1.logger.info(`[Decision] BUY $${token.ticker} — confidence ${vibe.confidencePercent}%`);
                await this.alerter.sendSignalAlert(scored);
                await this.executeBuy(scored);
                break;
            case 'WATCHLIST':
                logger_1.logger.info(`[Decision] WATCHLIST $${token.ticker}`);
                this.watchList.add(scored);
                break;
            case 'INVESTIGATE':
                // Cap re-investigation at 2 attempts to prevent infinite loops
                if (investigateCount >= 2) {
                    logger_1.logger.info(`[Decision] INVESTIGATE cap reached for $${token.ticker} — treating as SKIP`);
                    this.cycleGrokSkips.push({
                        ticker: token.ticker,
                        action: 'SKIP',
                        vibeScore: vibe.vibeScore,
                        scamPct: vibe.scamConfidencePercent,
                        oneLiner: 'Investigate limit reached',
                    });
                    return;
                }
                logger_1.logger.info(`[Decision] INVESTIGATE $${token.ticker} — re-queuing (attempt ${investigateCount + 1}/2)`);
                // Only re-queue if not already pending and queue has room
                if (!this.grokQueueMints.has(token.mintAddress) && this.grokQueue.length < this.GROK_QUEUE_MAX) {
                    this.grokQueue.push({
                        token: scored.token,
                        onChain: scored.onChain,
                        queuedAt: Date.now(),
                        investigateCount: investigateCount + 1,
                    });
                    this.grokQueueMints.add(token.mintAddress);
                }
                break;
            case 'SKIP':
            default:
                logger_1.logger.debug(`[Decision] SKIP $${token.ticker}`);
                this.cycleGrokSkips.push({
                    ticker: token.ticker,
                    action: 'SKIP',
                    vibeScore: vibe.vibeScore,
                    scamPct: vibe.scamConfidencePercent,
                    oneLiner: vibe.oneLiner || 'No signal',
                });
        }
    }
    // ── Trade execution (paper vs real) ──────────────────
    async executeBuy(scored) {
        if (this.modes.isPaper) {
            // Paper mode — simulate the position without touching Jupiter
            await this.positionManager.openPaperPosition(scored, this.solPriceUsd);
        }
        else {
            await this.positionManager.openPosition(scored, this.solPriceUsd);
        }
    }
    // ── Watchlist recheck ─────────────────────────────────
    async recheckWatchlist() {
        const due = this.watchList.getDue();
        if (due.length === 0)
            return;
        logger_1.logger.info(`[Watchlist] Rechecking ${due.length} tokens...`);
        for (const scored of due) {
            // Re-fetch fresh on-chain data from the appropriate source
            let fresh = null;
            if (this.modes.isPF && this.pfScanner) {
                fresh = await this.pfScanner.fetchPFData(scored.token.mintAddress);
            }
            else if (this.grdScanner) {
                fresh = await this.grdScanner.fetchRaydiumData(scored.token.mintAddress);
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
    async fetchSolPrice() {
        try {
            const { default: axios } = await Promise.resolve().then(() => __importStar(require('axios')));
            const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
            const price = res.data?.solana?.usd;
            if (price && typeof price === 'number') {
                this.solPriceUsd = price;
                this.pfScanner?.updateSolPrice(price);
                logger_1.logger.debug(`SOL price: $${price}`);
            }
        }
        catch {
            logger_1.logger.warn(`[Price] Using cached SOL price $${this.solPriceUsd}`);
        }
    }
    // ── Daily report + reflection ─────────────────────────
    scheduleDailyReport() {
        const run = async () => {
            logger_1.logger.info('[Daily] Running report + Opus reflection...');
            const today = this.memory.getTodayTrades();
            const all = this.memory.getAllTrades();
            const reflection = await this.reflection.runDailyReflection(today, all, {
                vibeThreshold: this.memory.vibeThreshold,
                confidenceThreshold: this.memory.confidenceThreshold,
                strategyMode: this.memory.strategyMode,
                consecutiveLosses: this.memory.consecutiveLosses,
                totalPnlUsd: this.memory.totalPnlUsd,
            });
            if (reflection) {
                this.memory.applyReflectionRecommendation(reflection.recommendedThresholdChange, reflection.recommendedStrategyMode, reflection.date);
            }
            await this.reporter.sendDailyTradeReport(today, reflection, {
                vibeThreshold: this.memory.vibeThreshold,
                strategyMode: this.memory.strategyMode,
                totalPnlUsd: this.memory.totalPnlUsd,
            });
        };
        const msUntilMidnight = () => {
            const now = new Date();
            const next = new Date(now);
            next.setUTCHours(23, 59, 0, 0);
            if (next <= now)
                next.setUTCDate(next.getUTCDate() + 1);
            return next.getTime() - now.getTime();
        };
        const schedule = () => setTimeout(async () => { await run(); schedule(); }, msUntilMidnight());
        schedule();
        logger_1.logger.info(`[Daily] Next report in ${(msUntilMidnight() / 3600000).toFixed(1)}h`);
    }
}
// ── Entry point ───────────────────────────────────────
async function main() {
    const hunter = new ShitcoinHunter();
    process.on('SIGINT', () => { logger_1.logger.info('Shutting down...'); process.exit(0); });
    process.on('unhandledRejection', (r) => logger_1.logger.error('Unhandled rejection', { reason: r }));
    await hunter.start();
}
main().catch((err) => {
    logger_1.logger.error('Fatal error', { error: err.message });
    process.exit(1);
});
//# sourceMappingURL=index.js.map