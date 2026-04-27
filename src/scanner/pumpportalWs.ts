/**
 * PumpPortalWsScanner — real-time new token feed via PumpPortal
 *
 * PumpPortal (wss://pumpportal.fun/api/data) is a community-built WebSocket
 * API that mirrors Pump.fun token creation events. It uses a clean JSON
 * protocol instead of Socket.IO, making it far more reliable for bots.
 *
 * Protocol:
 *   1. Connect to wss://pumpportal.fun/api/data
 *   2. Send {"method": "subscribeNewToken"} to start receiving events
 *   3. Each new token arrives as a JSON object with txType: "create"
 *
 * On-chain data (bonding curve, market cap etc.) is still fetched from the
 * Pump.fun REST API via the shared fetchPFTokenData function.
 *
 * Fallback: Pump.fun REST polling every 15s — same as PF WebSocket mode.
 */

import WebSocket from 'ws';
import EventEmitter from 'events';
import { NewToken } from '../types';
import { fetchPFTokenData, PFTokenData, IPFScanner, WsHealth } from './pumpfunWs';
import { logger } from '../logger';

const PP_WS_URL = 'wss://pumpportal.fun/api/data';

const GRADUATION_MCAP_USD = 69_000;

export class PumpPortalWsScanner extends EventEmitter implements IPFScanner {
  private ws: WebSocket | null = null;
  private seenMints = new Set<string>();
  private wsConnected = false;
  private reconnectDelay = 3_000;
  private lastWsMessageAt: number | null = null;
  private solPriceUsd = 150;   // updated via updateSolPrice()

  // ── Public API ────────────────────────────────────────
  start(): void {
    logger.info('[PP-WS] Starting PumpPortal WebSocket scanner (WebSocket only — no REST polling)...');
    this.connectWs();
  }

  stop(): void {
    this.ws?.close();
  }

  // ── WebSocket ─────────────────────────────────────────
  private connectWs(): void {
    try {
      this.ws = new WebSocket(PP_WS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      this.ws.on('open', () => {
        logger.info('[PP-WS] PumpPortal WebSocket connected');
        this.wsConnected = true;
        this.reconnectDelay = 3_000;
        this.lastWsMessageAt = Date.now();
        // Subscribe to new token creation events
        this.ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      });

      this.ws.on('message', (raw: Buffer) => {
        this.lastWsMessageAt = Date.now();
        this.handleWsMessage(raw.toString());
      });

      this.ws.on('close', () => {
        logger.warn(`[PP-WS] WebSocket closed — reconnecting in ${this.reconnectDelay / 1000}s`);
        this.wsConnected = false;
        setTimeout(() => this.connectWs(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      });

      this.ws.on('error', (err) => {
        logger.error('[PP-WS] WebSocket error', { error: err.message });
      });

    } catch (err: any) {
      logger.error('[PP-WS] Failed to connect', { error: err.message });
      setTimeout(() => this.connectWs(), this.reconnectDelay);
    }
  }

  private handleWsMessage(raw: string): void {
    try {
      const data = JSON.parse(raw);
      // PumpPortal emits txType: 'create' for new token launches
      if (data.txType !== 'create' || !data.mint) return;
      void this.handleNewToken(data);
    } catch {
      // Ignore non-JSON frames (heartbeats etc.)
    }
  }

  // ── Token handler ─────────────────────────────────────
  private async handleNewToken(data: any): Promise<void> {
    const mint = data.mint as string;
    if (this.seenMints.has(mint)) return;
    this.seenMints.add(mint);

    if (this.seenMints.size > 5_000) {
      const arr = Array.from(this.seenMints);
      this.seenMints = new Set(arr.slice(-2_000));
    }

    const ticker = (data.symbol ?? 'UNKNOWN').toUpperCase();
    const name   = data.name ?? 'Unknown';

    const token: NewToken = {
      mintAddress:   mint,
      name,
      ticker,
      description:   data.description    ?? '',
      creatorWallet: data.traderPublicKey ?? '',
      createdAt:     new Date(),
      pumpfunUrl:    `https://pump.fun/${mint}`,
    };

    const pfData: PFTokenData | null = this.buildPFDataFromEvent(data, mint, ticker)
      ?? await this.fetchPFData(mint, data);

    if (!pfData || pfData.graduated) return;

    // Profanity/queue outcome is logged by the caller (index.ts processToken)
    logger.info(`[PP-WS] New token detected: $${ticker} — "${name}"`);
    this.emit('token', token, pfData);
  }

  // ── Build PFTokenData from raw PumpPortal WS event ────────────────────────
  // PumpPortal sends vSolInBondingCurve (SOL) and vTokensInBondingCurve on create.
  private buildPFDataFromEvent(data: any, mint: string, ticker: string): PFTokenData | null {
    const vSol    = parseFloat(data.vSolInBondingCurve    ?? data.virtualSolReserves    ?? '0');
    const vTokens = parseFloat(data.vTokensInBondingCurve ?? data.virtualTokenReserves  ?? '0');
    const mcapSol = parseFloat(data.marketCapSol ?? '0');

    // If key fields are missing, can't build — caller will fall back to REST
    if (vSol === 0 && mcapSol === 0) return null;

    const sol          = this.solPriceUsd;
    const marketCapUsd = mcapSol > 0 ? mcapSol * sol : (vSol * sol * 2);
    const liquidityUsd = vSol * 2 * sol;
    const impliedPrice = vSol > 0 && vTokens > 0 ? (vSol / vTokens) * sol : 0;
    const initialBuy   = parseFloat(data.initialBuy ?? '0');
    const volumeUsd    = initialBuy * sol;
    const progress     = Math.min(100, (marketCapUsd / GRADUATION_MCAP_USD) * 100);
    const graduated    = marketCapUsd >= GRADUATION_MCAP_USD;

    return {
      mintAddress:          mint,
      liquidityUsd,
      volumeUsd24h:         volumeUsd,
      holderCount:          initialBuy > 0 ? 1 : 0,
      priceUsd:             impliedPrice,
      marketCapUsd,
      lpLocked:             false,
      devHoldingPercent:    0,
      ageMinutes:           0,
      dexscreenerUrl:       `https://pump.fun/${mint}`,
      bondingCurveProgress: progress,
      graduated,
      virtualSolReserves:   vSol,
      virtualTokenReserves: vTokens,
    };
  }

  // ── Bonding curve data — delegates to shared function ──
  async fetchPFData(mint: string, hint?: any): Promise<PFTokenData | null> {
    return fetchPFTokenData(mint, hint);
  }

  updateSolPrice(priceUsd: number): void {
    this.solPriceUsd = priceUsd;
  }

  getHealth(): WsHealth {
    const lastMessageMinutesAgo = this.lastWsMessageAt === null
      ? null
      : (Date.now() - this.lastWsMessageAt) / 60_000;

    return {
      source: 'PP',
      wsConnected: this.wsConnected,
      lastMessageAt: this.lastWsMessageAt,
      lastMessageMinutesAgo,
      reconnectDelay: this.reconnectDelay,
    };
  }
}
