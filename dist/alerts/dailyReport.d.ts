/**
 * DailyReport — sends all trades performed today to Telegram (item 7)
 * Also sends the Opus reflection summary
 */
import { TradeRecord, DailyReflection, MemoryState } from '../types';
export declare class DailyReporter {
    private bot;
    private chatId;
    constructor();
    sendDailyTradeReport(trades: TradeRecord[], reflection: DailyReflection | null, memoryState: {
        vibeThreshold: number;
        strategyMode: MemoryState['strategyMode'];
        totalPnlUsd: number;
    }): Promise<void>;
    private sendReflectionSummary;
    private send;
}
//# sourceMappingURL=dailyReport.d.ts.map