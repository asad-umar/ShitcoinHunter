/**
 * PreFilter — 3-stage zero-cost funnel before any Grok call
 *
 * Stage 0: Profanity filter    — reject tokens with offensive names/tickers
 * Stage 1: Hard numeric gates  — reject on bad on-chain metrics
 * Stage 2: Heuristic score     — local signal scoring, only ≥6 passes
 */
import { NewToken, TokenOnChainData } from '../types';
export type FilterStage = 'profanity' | 'hard_filter' | 'heuristic' | 'grok_skip' | 'passed';
export interface PreFilterResult {
    pass: boolean;
    stage: FilterStage;
    reason: string;
    heuristicScore?: number;
}
export declare class PreFilter {
    evaluate(token: NewToken, onChain: TokenOnChainData): PreFilterResult;
    private hardFilter;
    private heuristicScore;
    getThresholds(): {
        minLiquidityUsd: number;
        maxLiquidityUsd: number;
        minBuys1h: number;
        maxAgeMinutes: number;
        minMarketCapUsd: number;
        maxMarketCapUsd: number;
        minVolume1h: number;
        heuristicPassScore: number;
    };
    getProfanityList(): string[];
}
//# sourceMappingURL=prefilter.d.ts.map