import { MemoryState, TradeRecord, Position, AgentDecision, AdaptationEntry } from '../types';
export declare class TradeMemory {
    private state;
    private filePath;
    constructor();
    private ensureDir;
    private load;
    save(): void;
    recordTrade(position: Position, vibe: AgentDecision): void;
    adaptThresholds(): void;
    applyReflectionRecommendation(thresholdDelta: number, mode: MemoryState['strategyMode'], date: string): void;
    get vibeThreshold(): number;
    get confidenceThreshold(): number;
    get strategyMode(): MemoryState['strategyMode'];
    get consecutiveLosses(): number;
    get totalPnlUsd(): number;
    get lastReflectionDate(): string | null;
    getAllTrades(): TradeRecord[];
    getRecentTrades(n: number): TradeRecord[];
    getTodayTrades(): TradeRecord[];
    getAdaptationLog(): AdaptationEntry[];
    getSummary(): string;
}
//# sourceMappingURL=tradeMemory.d.ts.map