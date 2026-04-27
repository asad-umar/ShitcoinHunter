"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeMemory = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("../config");
const logger_1 = require("../logger");
const DEFAULT_STATE = {
    trades: [],
    currentVibeThreshold: config_1.config.trading.minVibeScore,
    currentConfidenceThreshold: config_1.config.trading.minConfidencePercent,
    strategyMode: 'normal',
    consecutiveLosses: 0,
    totalPnlUsd: 0,
    lastReflectionDate: null,
    adaptationLog: [],
};
class TradeMemory {
    constructor() {
        this.filePath = config_1.config.memory.filePath;
        this.ensureDir();
        this.state = this.load();
    }
    // ── Persistence ───────────────────────────────────────
    ensureDir() {
        const dir = path_1.default.dirname(this.filePath);
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
    }
    load() {
        try {
            if (fs_1.default.existsSync(this.filePath)) {
                const raw = fs_1.default.readFileSync(this.filePath, 'utf-8');
                return { ...DEFAULT_STATE, ...JSON.parse(raw) };
            }
        }
        catch (err) {
            logger_1.logger.warn('Could not load memory file, starting fresh', { error: err.message });
        }
        return { ...DEFAULT_STATE };
    }
    // Async write-behind — doesn't block the event loop during trade recording
    save() {
        const payload = JSON.stringify(this.state, null, 2);
        fs_1.default.promises.writeFile(this.filePath, payload).catch((err) => {
            logger_1.logger.error('Failed to save memory (async)', { error: err.message });
            // Fallback to sync on write failure so we never silently lose state
            try {
                fs_1.default.writeFileSync(this.filePath, payload);
            }
            catch (syncErr) {
                logger_1.logger.error('Failed to save memory (sync fallback)', { error: syncErr.message });
            }
        });
    }
    // ── Trade recording ───────────────────────────────────
    recordTrade(position, vibe) {
        const record = {
            id: position.id,
            ticker: position.ticker,
            mintAddress: position.mintAddress,
            vibeScoreAtEntry: vibe.vibeScore,
            confidenceAtEntry: vibe.confidencePercent,
            entryPriceUsd: position.entryPriceUsd,
            exitPriceUsd: position.exitPriceUsd ?? position.entryPriceUsd,
            amountUsdSpent: position.amountUsdSpent,
            pnlUsd: position.pnlUsd ?? 0,
            pnlPercent: position.pnlPercent ?? 0,
            exitReason: position.exitReason ?? 'manual',
            openedAt: position.openedAt.toISOString(),
            closedAt: new Date().toISOString(),
            narrative: vibe.narrative,
            kolSpotted: vibe.kolSpotted,
            redFlagsAtEntry: vibe.redFlags,
            dataSourcesUsed: vibe.dataFetched,
        };
        this.state.trades.push(record);
        this.state.totalPnlUsd += record.pnlUsd;
        if (record.pnlUsd < 0) {
            this.state.consecutiveLosses++;
        }
        else {
            this.state.consecutiveLosses = 0;
        }
        this.adaptThresholds();
        this.save();
    }
    // ── Adaptive threshold logic (item 1 & 4) ────────────
    adaptThresholds() {
        const recent = this.getRecentTrades(10);
        if (recent.length < 3)
            return; // not enough data yet
        const winRate = recent.filter((t) => t.pnlUsd > 0).length / recent.length;
        const avgPnl = recent.reduce((s, t) => s + t.pnlUsd, 0) / recent.length;
        const old = {
            threshold: this.state.currentVibeThreshold,
            mode: this.state.strategyMode,
        };
        let reason = '';
        // 4 or more consecutive losses → switch to conservative / pause
        if (this.state.consecutiveLosses >= config_1.config.memory.consecutiveLossLimit + 1) {
            this.state.strategyMode = 'paused';
            this.state.currentVibeThreshold = Math.min(9, this.state.currentVibeThreshold + 1);
            reason = `${this.state.consecutiveLosses} consecutive losses — pausing and tightening threshold`;
        }
        else if (this.state.consecutiveLosses >= config_1.config.memory.consecutiveLossLimit) {
            this.state.strategyMode = 'conservative';
            this.state.currentVibeThreshold = Math.min(9, this.state.currentVibeThreshold + 1);
            this.state.currentConfidenceThreshold = Math.min(98, this.state.currentConfidenceThreshold + 1);
            reason = `${this.state.consecutiveLosses} consecutive losses — switching conservative`;
        }
        else if (winRate >= 0.7 && avgPnl > 0 && this.state.strategyMode !== 'aggressive') {
            // Doing well — relax slightly
            this.state.strategyMode = 'aggressive';
            this.state.currentVibeThreshold = Math.max(6, this.state.currentVibeThreshold - 1);
            reason = `Win rate ${(winRate * 100).toFixed(0)}%, avg PnL $${avgPnl.toFixed(2)} — switching aggressive`;
        }
        else if (winRate >= 0.5 && avgPnl > 0 && this.state.strategyMode !== 'normal') {
            // Recovered — go back to normal
            this.state.strategyMode = 'normal';
            this.state.currentVibeThreshold = config_1.config.trading.minVibeScore;
            this.state.currentConfidenceThreshold = config_1.config.trading.minConfidencePercent;
            reason = `Win rate ${(winRate * 100).toFixed(0)}% — returning to normal mode`;
        }
        if (reason) {
            const entry = {
                timestamp: new Date().toISOString(),
                reason,
                oldThreshold: old.threshold,
                newThreshold: this.state.currentVibeThreshold,
                oldStrategyMode: old.mode,
                newStrategyMode: this.state.strategyMode,
            };
            this.state.adaptationLog.push(entry);
            logger_1.logger.info(`[ADAPTATION] ${reason}`);
            logger_1.logger.info(`  Vibe threshold: ${old.threshold} → ${this.state.currentVibeThreshold}`);
            logger_1.logger.info(`  Strategy: ${old.mode} → ${this.state.strategyMode}`);
        }
    }
    // Apply reflection-recommended changes (from Claude Opus)
    applyReflectionRecommendation(thresholdDelta, mode, date) {
        const old = { threshold: this.state.currentVibeThreshold, mode: this.state.strategyMode };
        this.state.currentVibeThreshold = Math.min(10, Math.max(5, this.state.currentVibeThreshold + thresholdDelta));
        this.state.strategyMode = mode;
        this.state.lastReflectionDate = date;
        const entry = {
            timestamp: new Date().toISOString(),
            reason: `Daily Opus reflection (${date})`,
            oldThreshold: old.threshold,
            newThreshold: this.state.currentVibeThreshold,
            oldStrategyMode: old.mode,
            newStrategyMode: mode,
        };
        this.state.adaptationLog.push(entry);
        this.save();
        logger_1.logger.info(`[REFLECTION APPLIED] threshold ${old.threshold}→${this.state.currentVibeThreshold}, mode: ${old.mode}→${mode}`);
    }
    // ── Getters ───────────────────────────────────────────
    get vibeThreshold() { return this.state.currentVibeThreshold; }
    get confidenceThreshold() { return this.state.currentConfidenceThreshold; }
    get strategyMode() { return this.state.strategyMode; }
    get consecutiveLosses() { return this.state.consecutiveLosses; }
    get totalPnlUsd() { return this.state.totalPnlUsd; }
    get lastReflectionDate() { return this.state.lastReflectionDate; }
    getAllTrades() { return this.state.trades; }
    getRecentTrades(n) {
        return this.state.trades.slice(-n);
    }
    getTodayTrades() {
        const today = new Date().toISOString().slice(0, 10);
        return this.state.trades.filter((t) => t.closedAt.startsWith(today));
    }
    getAdaptationLog() { return this.state.adaptationLog; }
    getSummary() {
        const total = this.state.trades.length;
        const wins = this.state.trades.filter((t) => t.pnlUsd > 0).length;
        return [
            `Total trades: ${total}`,
            `Win rate: ${total > 0 ? ((wins / total) * 100).toFixed(1) : 0}%`,
            `Total PnL: $${this.state.totalPnlUsd.toFixed(2)}`,
            `Consecutive losses: ${this.state.consecutiveLosses}`,
            `Strategy mode: ${this.state.strategyMode}`,
            `Vibe threshold: ${this.state.currentVibeThreshold}`,
        ].join(' | ');
    }
}
exports.TradeMemory = TradeMemory;
//# sourceMappingURL=tradeMemory.js.map