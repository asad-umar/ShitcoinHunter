"use strict";
/**
 * RaydiumScanner — GRD mode scanner
 *
 * Watches for tokens that have just graduated from Pump.fun onto Raydium.
 * Sources:
 *   1. Pump.fun REST — polls for coins where complete=true (newly graduated)
 *   2. DexScreener   — confirms liquidity landed on Raydium, gets pair data
 *
 * Only emits tokens where:
 *   - complete=true on Pump.fun (bonding curve finished)
 *   - Raydium pair exists on DexScreener with real liquidity
 *   - Token is fresh (graduated <30 min ago)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RaydiumScanner = void 0;
const axios_1 = __importDefault(require("axios"));
const events_1 = __importDefault(require("events"));
const logger_1 = require("../logger");
const PF_REST_URL = 'https://frontend-api.pump.fun/coins';
const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';
const MAX_AGE_AFTER_GRADUATION_MIN = 30;
class RaydiumScanner extends events_1.default {
    constructor() {
        super(...arguments);
        this.seenMints = new Set();
        this.pollInterval = null;
    }
    start() {
        logger_1.logger.info('[GRD] Starting Raydium/graduated token scanner...');
        this.poll(); // immediate first run
        this.pollInterval = setInterval(() => this.poll(), 30000);
    }
    stop() {
        if (this.pollInterval)
            clearInterval(this.pollInterval);
    }
    // ── Poll Pump.fun for newly graduated coins ───────────
    async poll() {
        try {
            // Pump.fun API: sort by graduation time, get recently completed
            const res = await axios_1.default.get(PF_REST_URL, {
                params: {
                    offset: 0,
                    limit: 50,
                    sort: 'last_trade_timestamp',
                    order: 'DESC',
                    includeNsfw: false,
                },
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            });
            const coins = res.data;
            if (!Array.isArray(coins))
                return;
            // Filter to only graduated (complete=true) coins
            const graduated = coins.filter((c) => Boolean(c.complete));
            logger_1.logger.debug(`[GRD] Poll: ${coins.length} coins, ${graduated.length} graduated`);
            for (const coin of graduated) {
                const mint = coin.mint;
                if (this.seenMints.has(mint))
                    continue;
                this.seenMints.add(mint);
                await this.processGraduated(coin);
            }
            // Trim seen set
            if (this.seenMints.size > 5000) {
                const arr = Array.from(this.seenMints);
                this.seenMints = new Set(arr.slice(-2000));
            }
        }
        catch (err) {
            logger_1.logger.warn('[GRD] Poll failed', { error: err.message });
        }
    }
    async processGraduated(coin) {
        const mint = coin.mint;
        // Check graduation age — ignore if too old
        const graduatedAt = coin.last_trade_timestamp
            ? new Date(coin.last_trade_timestamp)
            : new Date();
        const ageMinutes = (Date.now() - graduatedAt.getTime()) / 60000;
        if (ageMinutes > MAX_AGE_AFTER_GRADUATION_MIN) {
            logger_1.logger.debug(`[GRD] $${coin.symbol} graduated ${ageMinutes.toFixed(0)}m ago — too old`);
            return;
        }
        // Confirm Raydium pair exists with real liquidity
        const onChain = await this.fetchRaydiumData(mint);
        if (!onChain) {
            logger_1.logger.debug(`[GRD] $${coin.symbol} — no Raydium pair yet, will retry`);
            // Remove from seen so we retry next poll
            this.seenMints.delete(mint);
            return;
        }
        const token = {
            mintAddress: mint,
            name: coin.name ?? 'Unknown',
            ticker: (coin.symbol ?? 'UNKNOWN').toUpperCase(),
            description: coin.description ?? '',
            creatorWallet: coin.creator ?? '',
            createdAt: new Date(coin.created_timestamp ?? Date.now()),
            pumpfunUrl: `https://pump.fun/${mint}`,
            imageUrl: coin.image_uri,
        };
        logger_1.logger.info(`[GRD] Graduated token: $${token.ticker} — liq $${onChain.liquidityUsd.toFixed(0)}, age ${ageMinutes.toFixed(1)}m post-grad`);
        this.emit('token', token, onChain);
    }
    // ── DexScreener fetch (Raydium pair) ─────────────────
    async fetchRaydiumData(mint) {
        try {
            const res = await axios_1.default.get(`${DEXSCREENER}/${mint}`, { timeout: 8000 });
            const pairs = res.data?.pairs;
            if (!pairs || pairs.length === 0)
                return null;
            // Must be on Solana and specifically Raydium
            const raydiumPairs = pairs.filter((p) => p.chainId === 'solana' && p.dexId === 'raydium');
            if (raydiumPairs.length === 0)
                return null;
            // Highest liquidity Raydium pair
            const pair = raydiumPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
            const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date();
            const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
            return {
                mintAddress: mint,
                liquidityUsd: pair.liquidity?.usd ?? 0,
                volumeUsd24h: pair.volume?.h24 ?? 0,
                holderCount: pair.txns?.h24?.buys ?? 0,
                priceUsd: parseFloat(pair.priceUsd ?? '0'),
                marketCapUsd: pair.marketCap ?? 0,
                lpLocked: false,
                devHoldingPercent: 0,
                ageMinutes,
                // DexScreener chart link — this is the GRD chart URL
                dexscreenerUrl: pair.url ?? `https://dexscreener.com/solana/${mint}`,
            };
        }
        catch (err) {
            logger_1.logger.warn(`[GRD] DexScreener fetch failed for ${mint}`, { error: err.message });
            return null;
        }
    }
    // Also used by position monitor for price polling
    async getCurrentPriceUsd(mint) {
        try {
            const res = await axios_1.default.get(`${DEXSCREENER}/${mint}`, { timeout: 5000 });
            const pairs = res.data?.pairs?.filter((p) => p.chainId === 'solana' && p.dexId === 'raydium');
            if (!pairs?.length)
                return null;
            return parseFloat(pairs[0].priceUsd ?? '0') || null;
        }
        catch {
            return null;
        }
    }
}
exports.RaydiumScanner = RaydiumScanner;
//# sourceMappingURL=raydium.js.map