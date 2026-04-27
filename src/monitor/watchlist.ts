import { ScoredToken } from '../types';
import { logger } from '../logger';

interface WatchItem {
  scored: ScoredToken;
  addedAt: Date;
  recheckAt: Date;
  recheckCount: number;
}

export class WatchList {
  private items = new Map<string, WatchItem>();
  private readonly RECHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
  private readonly MAX_RECHECKS = 3;
  private readonly MAX_AGE_MS = 20 * 60 * 1000; // drop after 20 min

  add(scored: ScoredToken): void {
    const mint = scored.token.mintAddress;
    if (this.items.has(mint)) return;

    this.items.set(mint, {
      scored,
      addedAt: new Date(),
      recheckAt: new Date(Date.now() + this.RECHECK_INTERVAL_MS),
      recheckCount: 0,
    });

    logger.info(`Watchlist: added $${scored.token.ticker} (score ${scored.vibe.vibeScore})`);
  }

  getDue(): ScoredToken[] {
    const now = Date.now();
    const due: ScoredToken[] = [];

    for (const [mint, item] of this.items) {
      // Expired
      if (now - item.addedAt.getTime() > this.MAX_AGE_MS) {
        this.items.delete(mint);
        continue;
      }

      // Max rechecks hit
      if (item.recheckCount >= this.MAX_RECHECKS) {
        this.items.delete(mint);
        continue;
      }

      if (now >= item.recheckAt.getTime()) {
        due.push(item.scored);
        item.recheckCount++;
        item.recheckAt = new Date(now + this.RECHECK_INTERVAL_MS);
      }
    }

    return due;
  }

  remove(mintAddress: string): void {
    this.items.delete(mintAddress);
  }

  get size(): number {
    return this.items.size;
  }
}
