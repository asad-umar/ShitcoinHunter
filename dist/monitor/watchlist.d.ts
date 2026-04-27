import { ScoredToken } from '../types';
export declare class WatchList {
    private items;
    private readonly RECHECK_INTERVAL_MS;
    private readonly MAX_RECHECKS;
    private readonly MAX_AGE_MS;
    add(scored: ScoredToken): void;
    getDue(): ScoredToken[];
    remove(mintAddress: string): void;
    get size(): number;
}
//# sourceMappingURL=watchlist.d.ts.map