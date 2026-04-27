import axios from 'axios';
import { TokenOnChainData } from '../types';
import { logger } from '../logger';

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
const BIRDEYE_API = 'https://public-api.birdeye.so/defi';

function parseDateLike(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    if (value > 1_000_000_000_000) return new Date(value);
    if (value > 1_000_000_000) return new Date(value * 1000);
    return null;
  }
  if (typeof value === 'string') {
    const asNum = Number(value);
    if (!Number.isNaN(asNum)) {
      return parseDateLike(asNum);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

export function parseLastTradeMinutesAgo(source: any): number | undefined {
  if (!source) return undefined;

  const candidate = source.lastTradeAt ?? source.last_trade_at ?? source.lastTradeTimestamp ?? source.last_trade_timestamp
    ?? source.lastTradeTime ?? source.tradeAt ?? source.trade_timestamp ?? source.lastTrade;

  const date = parseDateLike(candidate);
  if (!date) return undefined;

  const minutes = (Date.now() - date.getTime()) / 60000;
  return minutes >= 0 ? minutes : undefined;
}

export class OnChainFetcher {
  async fetchTokenData(mintAddress: string): Promise<TokenOnChainData | null> {
    try {
      // Primary: DexScreener (free, no key needed)
      const dexData = await this.fetchDexScreener(mintAddress);
      if (dexData) return dexData;

      // Fallback: basic on-chain check
      return null;
    } catch (err: any) {
      logger.warn(`OnChain fetch failed for ${mintAddress}`, { error: err.message });
      return null;
    }
  }

  private async fetchDexScreener(mintAddress: string): Promise<TokenOnChainData | null> {
    try {
      const res = await axios.get(`${DEXSCREENER_API}/${mintAddress}`, {
        timeout: 8000,
      });

      const pairs = res.data?.pairs;
      if (!pairs || pairs.length === 0) return null;

      // Pick the highest liquidity Solana pair
      const solPairs = pairs.filter((p: any) => p.chainId === 'solana');
      if (solPairs.length === 0) return null;

      const pair = solPairs.sort(
        (a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];

      const createdAt = pair.pairCreatedAt
        ? new Date(pair.pairCreatedAt)
        : new Date();
      const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;

      return {
        mintAddress,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        volumeUsd24h: pair.volume?.h24 ?? 0,
        holderCount: pair.txns?.h24?.buys ?? 0, // rough proxy
        priceUsd: parseFloat(pair.priceUsd ?? '0'),
        marketCapUsd: pair.marketCap ?? 0,
        lpLocked: false, // DexScreener doesn't expose this directly — check separately
        devHoldingPercent: 0, // would need Helius or Birdeye for this
        ageMinutes,
        lastTradeMinutesAgo: parseLastTradeMinutesAgo(pair),
        dexscreenerUrl: pair.url ?? `https://dexscreener.com/solana/${mintAddress}`,
      };
    } catch {
      return null;
    }
  }

  // Lightweight rug check — filters out the obvious garbage before Grok call
  isRugged(data: TokenOnChainData): { rugged: boolean; reason: string } {
    if (data.liquidityUsd < 500) {
      return { rugged: true, reason: `Liquidity too low: $${data.liquidityUsd}` };
    }
    if (data.holderCount < 10) {
      return { rugged: true, reason: `Too few buyers: ${data.holderCount}` };
    }
    if (data.devHoldingPercent > 20) {
      return { rugged: true, reason: `Dev holds ${data.devHoldingPercent}%` };
    }
    return { rugged: false, reason: '' };
  }

  // Poll current price for position monitoring
  async getCurrentPriceUsd(mintAddress: string): Promise<number | null> {
    try {
      const res = await axios.get(`${DEXSCREENER_API}/${mintAddress}`, {
        timeout: 5000,
      });
      const pairs = res.data?.pairs?.filter((p: any) => p.chainId === 'solana');
      if (!pairs?.length) return null;
      return parseFloat(pairs[0].priceUsd ?? '0') || null;
    } catch {
      return null;
    }
  }
}
