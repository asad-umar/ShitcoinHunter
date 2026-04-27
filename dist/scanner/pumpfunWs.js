"use strict";
/**
 * PumpFunWsScanner — real-time Pump.fun new token feed
 *
 * Primary:  WebSocket subscription to wss://frontend-api.pump.fun
 *           Emits a NewToken the moment a coin is created on the bonding curve.
 *
 * Fallback: REST polling every 15s (same as original PumpFunScanner but faster)
 *           Kicks in automatically if WS disconnects or fails to connect.
 *
 * Bonding curve data is fetched via the Pump.fun coin endpoint, giving us:
 *   - real usd_market_cap, virtual_sol_reserves, virtual_token_reserves
 *   - complete (bonding curve filled %) — graduation check
 *   - no DexScreener dependency at all for PF mode
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PumpFunWsScanner = void 0;
const ws_1 = __importDefault(require("ws"));
const axios_1 = __importDefault(require("axios"));
const events_1 = __importDefault(require("events"));
const logger_1 = require("../logger");
const PF_WS_URL = 'wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket';
const PF_REST_URL = 'https://frontend-api.pump.fun/coins';
const PF_COIN_URL = 'https://frontend-api.pump.fun/coins'; // /<mint>
// Pump.fun graduation threshold (bonding curve fills to ~$69k MCap)
const GRADUATION_MCAP_USD = 69000;
class PumpFunWsScanner extends events_1.default {
    constructor() {
        super(...arguments);
        this.ws = null;
        this.seenMints = new Set();
        this.restFallbackInterval = null;
        this.wsConnected = false;
        this.reconnectDelay = 3000;
        this.lastRestCheck = Date.now();
    }
    // ── Public API ────────────────────────────────────────
    start() {
        logger_1.logger.info('[PF-WS] Starting Pump.fun WebSocket scanner...');
        this.connectWs();
        // Always run REST as safety net — it catches anything WS misses
        this.restFallbackInterval = setInterval(() => this.restFallback(), 15000);
    }
    stop() {
        this.ws?.close();
        if (this.restFallbackInterval)
            clearInterval(this.restFallbackInterval);
    }
    // ── WebSocket ─────────────────────────────────────────
    connectWs() {
        try {
            this.ws = new ws_1.default(PF_WS_URL, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            this.ws.on('open', () => {
                logger_1.logger.info('[PF-WS] WebSocket connected');
                this.wsConnected = true;
                this.reconnectDelay = 3000;
                // Socket.IO handshake
                this.ws.send('40');
            });
            this.ws.on('message', (raw) => {
                this.handleWsMessage(raw.toString());
            });
            this.ws.on('close', () => {
                logger_1.logger.warn(`[PF-WS] WebSocket closed — reconnecting in ${this.reconnectDelay / 1000}s`);
                this.wsConnected = false;
                setTimeout(() => this.connectWs(), this.reconnectDelay);
                this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
            });
            this.ws.on('error', (err) => {
                logger_1.logger.error('[PF-WS] WebSocket error', { error: err.message });
            });
        }
        catch (err) {
            logger_1.logger.error('[PF-WS] Failed to connect', { error: err.message });
            setTimeout(() => this.connectWs(), this.reconnectDelay);
        }
    }
    handleWsMessage(raw) {
        try {
            // Socket.IO ping/pong
            if (raw === '2') {
                this.ws?.send('3');
                return;
            }
            if (raw === '40') {
                return;
            }
            // Strip Socket.IO envelope prefix (e.g. "42[...")
            const jsonStart = raw.indexOf('[');
            if (jsonStart === -1)
                return;
            const payload = JSON.parse(raw.slice(jsonStart));
            if (!Array.isArray(payload) || payload[0] !== 'newCoinCreated')
                return;
            const coin = payload[1];
            if (!coin?.mint)
                return;
            this.handleNewCoin(coin);
        }
        catch {
            // Ignore parse errors — WS stream has non-JSON frames
        }
    }
    // ── Shared coin handler ───────────────────────────────
    async handleNewCoin(coin) {
        const mint = coin.mint;
        if (this.seenMints.has(mint))
            return;
        this.seenMints.add(mint);
        // Trim seen set
        if (this.seenMints.size > 5000) {
            const arr = Array.from(this.seenMints);
            this.seenMints = new Set(arr.slice(-2000));
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
        // Fetch bonding curve data
        const pfData = await this.fetchPFData(mint, coin);
        if (!pfData)
            return;
        // Skip if already graduated — GRD mode handles those
        if (pfData.graduated) {
            logger_1.logger.debug(`[PF-WS] $${token.ticker} already graduated — skip in PF mode`);
            return;
        }
        this.emit('token', token, pfData);
    }
    // ── Pump.fun bonding curve fetch ──────────────────────
    async fetchPFData(mint, coinHint) {
        try {
            // Use hint data if available (from WS), otherwise hit REST
            let coin = coinHint;
            if (!coin || !coin.usd_market_cap) {
                const res = await axios_1.default.get(`${PF_COIN_URL}/${mint}`, { timeout: 6000 });
                coin = res.data;
            }
            if (!coin)
                return null;
            const marketCapUsd = parseFloat(coin.usd_market_cap ?? '0');
            const vSolReserves = parseFloat(coin.virtual_sol_reserves ?? '0') / 1e9;
            const vTokenReserves = parseFloat(coin.virtual_token_reserves ?? '0') / 1e6;
            const graduated = Boolean(coin.complete) || marketCapUsd >= GRADUATION_MCAP_USD;
            // Bonding curve progress: market cap / graduation threshold
            const progress = Math.min(100, (marketCapUsd / GRADUATION_MCAP_USD) * 100);
            // Implied price from reserves (SOL per token, converted via rough SOL price)
            // We'll use a placeholder SOL price here — index.ts injects real one
            const impliedPriceSOL = vSolReserves > 0 && vTokenReserves > 0
                ? vSolReserves / vTokenReserves
                : 0;
            // Liquidity proxy: virtual SOL reserves * 2 (AMM convention) * ~$150 SOL
            // Real SOL price injected at runtime — use 150 as safe fallback
            const liquidityUsd = vSolReserves * 2 * 150;
            const createdAt = coin.created_timestamp
                ? new Date(coin.created_timestamp)
                : new Date();
            const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
            return {
                mintAddress: mint,
                liquidityUsd,
                volumeUsd24h: parseFloat(coin.volume ?? '0'),
                holderCount: parseInt(coin.holder_count ?? coin.reply_count ?? '0'),
                priceUsd: impliedPriceSOL * 150, // refined in index.ts
                marketCapUsd,
                lpLocked: false, // n/a on bonding curve
                devHoldingPercent: 0, // requires Helius
                ageMinutes,
                dexscreenerUrl: `https://pump.fun/${mint}`, // chart link for PF mode
                bondingCurveProgress: progress,
                graduated,
                virtualSolReserves: vSolReserves,
                virtualTokenReserves: vTokenReserves,
            };
        }
        catch (err) {
            logger_1.logger.warn(`[PF-WS] fetchPFData failed for ${mint}`, { error: err.message });
            return null;
        }
    }
    // ── REST fallback ─────────────────────────────────────
    async restFallback() {
        try {
            const res = await axios_1.default.get(PF_REST_URL, {
                params: { offset: 0, limit: 50, sort: 'creation_time', order: 'DESC', includeNsfw: false },
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            });
            const coins = res.data;
            if (!Array.isArray(coins))
                return;
            for (const coin of coins) {
                const createdAt = new Date(coin.created_timestamp);
                // Only process coins newer than our last check
                if (createdAt.getTime() < this.lastRestCheck - 30000)
                    continue;
                await this.handleNewCoin(coin);
            }
            this.lastRestCheck = Date.now();
        }
        catch (err) {
            logger_1.logger.warn('[PF-WS] REST fallback failed', { error: err.message });
        }
    }
    // Inject real SOL price so liquidity calculations are accurate
    updateSolPrice(priceUsd) {
        // Used externally — PFTokenData.liquidityUsd is recomputed in index.ts
        // after this is set. Stored here for reference only.
        this._solPriceUsd = priceUsd;
    }
}
exports.PumpFunWsScanner = PumpFunWsScanner;
//# sourceMappingURL=pumpfunWs.js.map