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

import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';
import { NewToken, TokenOnChainData } from '../types';
import { OnChainFetcher, parseLastTradeMinutesAgo } from './onchain';
import { logger } from '../logger';

const PF_WS_URL   = 'wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket';
const PF_REST_URL = 'https://frontend-api.pump.fun/coins';
const PF_COIN_URL = 'https://frontend-api.pump.fun/coins';   // /<mint>

// Pump.fun graduation threshold (bonding curve fills to ~$69k MCap)
const GRADUATION_MCAP_USD = 69_000;

export interface PFTokenData extends TokenOnChainData {
  bondingCurveProgress: number;   // 0-100 %
  graduated: boolean;
  virtualSolReserves: number;
  virtualTokenReserves: number;
}

export interface WsHealth {
  source: 'PF' | 'PP' | 'GRD';
  wsConnected: boolean;
  lastMessageAt: number | null;
  lastMessageMinutesAgo: number | null;
  reconnectDelay: number;
}

// Shared interface — both WS providers implement this so index.ts stays generic
export interface IPFScanner extends EventEmitter {
  start(): void;
  stop(): void;
  fetchPFData(mint: string, hint?: any): Promise<PFTokenData | null>;
  updateSolPrice(priceUsd: number): void;
  getHealth(): WsHealth;
}

// Suppress repeated Pump.fun REST error noise — only log the first failure
let pfRestFailedOnce = false;

// ── Standalone fetch — shared by both WS providers ────────────────────────────
export async function fetchPFTokenData(mint: string, coinHint?: any): Promise<PFTokenData | null> {
  try {
    let coin = coinHint;
    if (!coin || !coin.usd_market_cap) {
      const res = await axios.get(`${PF_COIN_URL}/${mint}`, { timeout: 6_000 });
      coin = res.data;
    }

    if (!coin) return null;

    const marketCapUsd   = parseFloat(coin.usd_market_cap      ?? '0');
    const vSolReserves   = parseFloat(coin.virtual_sol_reserves ?? '0') / 1e9;
    const vTokenReserves = parseFloat(coin.virtual_token_reserves ?? '0') / 1e6;
    const graduated      = Boolean(coin.complete) || marketCapUsd >= GRADUATION_MCAP_USD;
    const progress       = Math.min(100, (marketCapUsd / GRADUATION_MCAP_USD) * 100);
    const impliedPriceSOL = vSolReserves > 0 && vTokenReserves > 0
      ? vSolReserves / vTokenReserves : 0;
    const liquidityUsd   = vSolReserves * 2 * 150;
    const createdAt      = coin.created_timestamp ? new Date(coin.created_timestamp) : new Date();
    const ageMinutes     = (Date.now() - createdAt.getTime()) / 60_000;

    return {
      mintAddress:          mint,
      liquidityUsd,
      volumeUsd24h:         parseFloat(coin.volume ?? '0'),
      holderCount:          parseInt(coin.holder_count ?? coin.reply_count ?? '0'),
      priceUsd:             impliedPriceSOL * 150,
      marketCapUsd,
      lpLocked:             false,
      devHoldingPercent:    0,
      ageMinutes,
      lastTradeMinutesAgo:  parseLastTradeMinutesAgo(coin),
      dexscreenerUrl:       `https://pump.fun/${mint}`,
      bondingCurveProgress: progress,
      graduated,
      virtualSolReserves:   vSolReserves,
      virtualTokenReserves: vTokenReserves,
    };
  } catch (err: any) {
    if (!pfRestFailedOnce) {
      logger.warn(`[PF] Pump.fun REST API is down (${err.message}) — switching to DexScreener fallback for all tokens`);
      pfRestFailedOnce = true;
    } else {
      logger.debug(`[PF] Pump.fun REST still down for ${mint} — trying DexScreener`);
    }

    try {
      const dex = await new OnChainFetcher().fetchTokenData(mint);
      if (!dex) {
        logger.info(`[PF] DexScreener: no data yet for ${mint} (token too new) — skipping`);
        return null;
      }

      const progress = dex.marketCapUsd > 0
        ? Math.min(100, (dex.marketCapUsd / GRADUATION_MCAP_USD) * 100)
        : 0;
      const graduated = dex.marketCapUsd >= GRADUATION_MCAP_USD;

      // DexScreener reports $0 liquidity for bonding-curve tokens because there
      // is no AMM pool — only virtual reserves. Estimate from MCap (vSol ≈ MCap/2
      // on the Pump.fun curve) so the liquidity filter is not trivially failed.
      if (dex.liquidityUsd === 0 && dex.marketCapUsd > 0) {
        dex.liquidityUsd = dex.marketCapUsd * 0.5;
        logger.debug(`[PF] DexScreener: $0 pool liquidity (bonding curve) — estimated from MCap: $${dex.liquidityUsd.toFixed(0)}`);
      }

      logger.debug(`[PF] DexScreener OK for ${mint} — MCap $${dex.marketCapUsd.toFixed(0)}, Liq $${dex.liquidityUsd.toFixed(0)}`);
      return {
        ...dex,
        bondingCurveProgress: progress,
        graduated,
        virtualSolReserves:   0,
        virtualTokenReserves: 0,
      };
    } catch (dexErr: any) {
      logger.warn(`[PF] DexScreener also failed for ${mint}`, { error: dexErr.message });
      return null;
    }
  }
}

export class PumpFunWsScanner extends EventEmitter implements IPFScanner {
  private ws: WebSocket | null = null;
  private seenMints = new Set<string>();
  private restFallbackInterval: NodeJS.Timeout | null = null;
  private wsConnected = false;
  private reconnectDelay = 3_000;
  private lastWsMessageAt: number | null = null;
  private lastRestCheck = Date.now();

  // ── Public API ────────────────────────────────────────
  start(): void {
    logger.info('[PF-WS] Starting Pump.fun WebSocket scanner...');
    this.connectWs();
    // Always run REST as safety net — it catches anything WS misses
    this.restFallbackInterval = setInterval(() => this.restFallback(), 15_000);
  }

  stop(): void {
    this.ws?.close();
    if (this.restFallbackInterval) clearInterval(this.restFallbackInterval);
  }

  // ── WebSocket ─────────────────────────────────────────
  private connectWs(): void {
    try {
      this.ws = new WebSocket(PF_WS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      this.ws.on('open', () => {
        logger.info('[PF-WS] WebSocket connected');
        this.wsConnected = true;
        this.reconnectDelay = 3_000;
        this.lastWsMessageAt = Date.now();
        // Socket.IO handshake
        this.ws!.send('40');
      });

      this.ws.on('message', (raw: Buffer) => {
        this.lastWsMessageAt = Date.now();
        this.handleWsMessage(raw.toString());
      });

      this.ws.on('close', () => {
        logger.warn(`[PF-WS] WebSocket closed — reconnecting in ${this.reconnectDelay / 1000}s`);
        this.wsConnected = false;
        setTimeout(() => this.connectWs(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      });

      this.ws.on('error', (err) => {
        logger.error('[PF-WS] WebSocket error', { error: err.message });
      });

    } catch (err: any) {
      logger.error('[PF-WS] Failed to connect', { error: err.message });
      setTimeout(() => this.connectWs(), this.reconnectDelay);
    }
  }

  private handleWsMessage(raw: string): void {
    try {
      // Socket.IO ping/pong
      if (raw === '2')  { this.ws?.send('3'); return; }
      if (raw === '40') { return; }

      // Strip Socket.IO envelope prefix (e.g. "42[...")
      const jsonStart = raw.indexOf('[');
      if (jsonStart === -1) return;

      const payload = JSON.parse(raw.slice(jsonStart));
      if (!Array.isArray(payload) || payload[0] !== 'newCoinCreated') return;

      const coin = payload[1];
      if (!coin?.mint) return;

      this.handleNewCoin(coin);
    } catch {
      // Ignore parse errors — WS stream has non-JSON frames
    }
  }

  // ── Shared coin handler ───────────────────────────────
  private async handleNewCoin(coin: any): Promise<void> {
    const mint = coin.mint as string;
    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    // Trim seen set
    if (this.seenMints.size > 5_000) {
      const arr = Array.from(this.seenMints);
      this.seenMints = new Set(arr.slice(-2_000));
    }

    logger.info(`[PF-WS] New token: $${(coin.symbol ?? 'UNKNOWN').toUpperCase()} — ${coin.name ?? ''} (${mint})`);

    const token: NewToken = {
      mintAddress: mint,
      name:         coin.name        ?? 'Unknown',
      ticker:       (coin.symbol     ?? 'UNKNOWN').toUpperCase(),
      description:  coin.description ?? '',
      creatorWallet: coin.creator    ?? '',
      createdAt:    new Date(coin.created_timestamp ?? Date.now()),
      pumpfunUrl:   `https://pump.fun/${mint}`,
      imageUrl:     coin.image_uri,
    };

    // Fetch bonding curve data
    const pfData = await this.fetchPFData(mint, coin);
    if (!pfData) return;

    // Skip if already graduated — GRD mode handles those
    if (pfData.graduated) {
      logger.debug(`[PF-WS] $${token.ticker} already graduated — skip in PF mode`);
      return;
    }

    this.emit('token', token, pfData);
  }

  // ── Pump.fun bonding curve fetch — delegates to shared function ──────────
  async fetchPFData(mint: string, coinHint?: any): Promise<PFTokenData | null> {
    return fetchPFTokenData(mint, coinHint);
  }

  // ── REST fallback ─────────────────────────────────────
  private async restFallback(): Promise<void> {
    try {
      const res = await axios.get(PF_REST_URL, {
        params: { offset: 0, limit: 50, sort: 'creation_time', order: 'DESC', includeNsfw: false },
        timeout: 10_000,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });

      const coins = res.data;
      if (!Array.isArray(coins)) return;

      for (const coin of coins) {
        const createdAt = new Date(coin.created_timestamp);
        // Only process coins newer than our last check
        if (createdAt.getTime() < this.lastRestCheck - 30_000) continue;
        await this.handleNewCoin(coin);
      }

      this.lastRestCheck = Date.now();
    } catch (err: any) {
      logger.warn('[PF-WS] REST fallback failed', { error: err.message });
    }
  }

  // Inject real SOL price so liquidity calculations are accurate
  updateSolPrice(priceUsd: number): void {
    // Used externally — PFTokenData.liquidityUsd is recomputed in index.ts
    // after this is set. Stored here for reference only.
    (this as any)._solPriceUsd = priceUsd;
  }

  getHealth(): WsHealth {
    const lastMessageMinutesAgo = this.lastWsMessageAt === null
      ? null
      : (Date.now() - this.lastWsMessageAt) / 60_000;

    return {
      source: 'PF',
      wsConnected: this.wsConnected,
      lastMessageAt: this.lastWsMessageAt,
      lastMessageMinutesAgo,
      reconnectDelay: this.reconnectDelay,
    };
  }
}
