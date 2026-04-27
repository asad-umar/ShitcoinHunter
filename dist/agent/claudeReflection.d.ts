/**
 * ClaudeReflection — Daily Opus-powered reflection (items 1, 4 & 6)
 *
 * At the end of each day, Claude Opus:
 * - Reviews all trades made that day
 * - Identifies patterns in what worked and what didn't
 * - Recommends threshold adjustments
 * - Detects if the strategy is failing and suggests a mode change
 * - Saves the reflection to disk
 */
import { TradeRecord, DailyReflection, MemoryState } from '../types';
export declare class ClaudeReflection {
    private client;
    constructor();
    runDailyReflection(todayTrades: TradeRecord[], allTrades: TradeRecord[], currentState: {
        vibeThreshold: number;
        confidenceThreshold: number;
        strategyMode: MemoryState['strategyMode'];
        consecutiveLosses: number;
        totalPnlUsd: number;
    }): Promise<DailyReflection | null>;
    private buildReflectionPrompt;
    private parseReflection;
    private saveReflection;
}
//# sourceMappingURL=claudeReflection.d.ts.map