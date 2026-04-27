import { Position, ScoredToken } from '../types';
import { JupiterTrader } from './jupiter';
import { OnChainFetcher } from '../scanner/onchain';
import { TelegramAlerter } from '../alerts/telegram';
export declare class PositionManager {
    private positions;
    private trader;
    private fetcher;
    private alerter;
    private monitorInterval;
    constructor(trader: JupiterTrader, fetcher: OnChainFetcher, alerter: TelegramAlerter);
    openPosition(scored: ScoredToken): Promise<Position | null>;
    closePosition(mintAddress: string, reason: Position['exitReason']): Promise<void>;
    startMonitoring(intervalMs?: number): void;
    stopMonitoring(): void;
    private checkPositions;
    private evaluatePosition;
    get openPositions(): Position[];
    get allPositions(): Position[];
    getPosition(mintAddress: string): Position | undefined;
    printSummary(): void;
}
//# sourceMappingURL=positions.d.ts.map