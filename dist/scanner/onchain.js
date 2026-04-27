"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnChainFetcher = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../logger");
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens';
const BIRDEYE_API = 'https://public-api.birdeye.so/defi';
class OnChainFetcher {
    async fetchTokenData(mintAddress) {
        try {
            // Primary: DexScreener (free, no key needed)
            const dexData = await this.fetchDexScreener(mintAddress);
            if (dexData)
                return dexData;
            // Fallback: basic on-chain check
            return null;
        }
        catch (err) {
            logger_1.logger.warn(`OnChain fetch failed for ${mintAddress}`, { error: err.message });
            return null;
        }
    }
    async fetchDexScreener(mintAddress) {
        try {
            const res = await axios_1.default.get(`${DEXSCREENER_API}/${mintAddress}`, {
                timeout: 8000,
            });
            const pairs = res.data?.pairs;
            if (!pairs || pairs.length === 0)
                return null;
            // Pick the highest liquidity Solana pair
            const solPairs = pairs.filter((p) => p.chainId === 'solana');
            if (solPairs.length === 0)
                return null;
            const pair = solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
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
                dexscreenerUrl: pair.url ?? `https://dexscreener.com/solana/${mintAddress}`,
            };
        }
        catch {
            return null;
        }
    }
    // Lightweight rug check — filters out the obvious garbage before Grok call
    isRugged(data) {
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
    async getCurrentPriceUsd(mintAddress) {
        try {
            const res = await axios_1.default.get(`${DEXSCREENER_API}/${mintAddress}`, {
                timeout: 5000,
            });
            const pairs = res.data?.pairs?.filter((p) => p.chainId === 'solana');
            if (!pairs?.length)
                return null;
            return parseFloat(pairs[0].priceUsd ?? '0') || null;
        }
        catch {
            return null;
        }
    }
}
exports.OnChainFetcher = OnChainFetcher;
//# sourceMappingURL=onchain.js.map