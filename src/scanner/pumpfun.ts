import axios from 'axios';
import { NewToken } from '../types';
import { logger } from '../logger';

// Pump.fun API returns coins in reverse chronological order
const PUMPFUN_API = 'https://frontend-api.pump.fun/coins';

export class PumpFunScanner {
  private seenMints = new Set<string>();
  private lastCheckTime = Date.now();

  async getLatestTokens(): Promise<NewToken[]> {
    try {
      const response = await axios.get(PUMPFUN_API, {
        params: {
          offset: 0,
          limit: 50,
          sort: 'creation_time',
          order: 'DESC',
          includeNsfw: false,
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
        },
      });

      const coins = response.data;
      if (!Array.isArray(coins)) return [];

      const newTokens: NewToken[] = [];

      for (const coin of coins) {
        const mint = coin.mint as string;

        // Skip already seen
        if (this.seenMints.has(mint)) continue;
        this.seenMints.add(mint);

        // Only process coins created after our last check
        const createdAt = new Date(coin.created_timestamp);
        if (createdAt.getTime() < this.lastCheckTime - 60_000) continue;

        newTokens.push({
          mintAddress: mint,
          name: coin.name ?? 'Unknown',
          ticker: (coin.symbol ?? 'UNKNOWN').toUpperCase(),
          description: coin.description ?? '',
          creatorWallet: coin.creator ?? '',
          createdAt,
          pumpfunUrl: `https://pump.fun/${mint}`,
          imageUrl: coin.image_uri,
        });
      }

      this.lastCheckTime = Date.now();

      // Prevent the seen set from growing unbounded
      if (this.seenMints.size > 5000) {
        const arr = Array.from(this.seenMints);
        this.seenMints = new Set(arr.slice(-2000));
      }

      if (newTokens.length > 0) {
        logger.info(`PumpFun: found ${newTokens.length} new tokens`);
      }

      return newTokens;
    } catch (err: any) {
      logger.error('PumpFun scanner error', { error: err.message });
      return [];
    }
  }
}
