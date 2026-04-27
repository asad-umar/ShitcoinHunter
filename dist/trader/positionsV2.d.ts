/**
 * PositionManagerV2 — USD-denominated position management
 *
 * Rules:
 *   - Buy:            never spend more than $10 per position
 *   - Take profit:    sell when position value hits $20
 *   - Trailing stop:  once above entry, trail by TRAIL_PCT (default 25%)
 *                     e.g. peaks at $18 → stop fires at $13.50
 *   - Hard stop loss: sell if value drops below $5 (catches slow bleeds before rally)
 *   - Timeout:        sell after MAX_HOLD_MINUTES regardless
 *
 * Fixes applied:
 *   - openPaperPosition moved inside class (was accidentally outside)
 *   - PnL now computed from actual Jupiter swap output, not price ratio
 *   - solPriceUsd stored at open so paper close uses consistent pricing
 *   - Trailing stop replaces static stop loss for positions that run green
 */
import { Position, ScoredToken } from '../types';
import { JupiterTrader } from './jupiter';
import { OnChainFetcher } from '../scanner/onchain';
import { TelegramAlerter } from '../alerts/telegram';
import { TradeMemory } from '../memory/tradeMemory';
export declare class PositionManagerV2 {
    private trader;
    private fetcher;
    private alerter;
    private memory;
    private positions;
    private vibeAtEntry;
    private solPriceAtOpen;
    private monitorInterval;
    constructor(trader: JupiterTrader, fetcher: OnChainFetcher, alerter: TelegramAlerter, memory: TradeMemory);
    openPosition(scored: ScoredToken, solPriceUsd: number): Promise<Position | null>;
    openPaperPosition(scored: ScoredToken, solPriceUsd: number): Promise<Position | null>;
    closePosition(mintAddress: string, reason: Position['exitReason'], currentPriceUsd: number): Promise<void>;
    startMonitoring(intervalMs?: number): void;
    stopMonitoring(): void;
    private checkPositions;
    private evaluatePosition;
    get openPositions(): Position[];
    get allPositions(): Position[];
    printSummary(): void;
}
//# sourceMappingURL=positionsV2.d.ts.map