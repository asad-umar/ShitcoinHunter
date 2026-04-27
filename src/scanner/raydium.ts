/**
 * RaydiumScanner — GRD mode scanner
 *
 * Watches for tokens that have just graduated from Pump.fun onto Raydium.
 *
 * Source:  PumpPortal WebSocket — subscribes to migration events.
 *          Emits the instant a bonding curve completes and migrates to Raydium.
 *          No dependency on Pump.fun REST API.
 *
 * On migration event: token is immediately queued with placeholder on-chain data.
 * Actual DexScreener fetch + evaluation happens 15 minutes later via processMatureQueue.
 */

import WebSocket from 'ws';
import axios from 'axios';
import EventEmitter from 'events';
import { NewToken, TokenOnChainData } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { WsHealth } from './pumpfunWs';
import { parseLastTradeMinutesAgo } from './onchain';

const PP_WS_URL   = 'wss://pumpportal.fun/api/data';
const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens';

export class RaydiumScanner extends EventEmitter {
  private ws: WebSocket | null = null;
  private seenMints         = new Set<string>();
  private reconnectDelay    = 3_000;
  private wsConnected       = false;
  private lastWsMessageAt:  number | null = null;
  private disconnectedSince: number | null = null;   // tracks when wsConnected first went false

  // Keepalive — ping every 30s, watchdog terminates if stale for 2 min
  private pingInterval:     NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL_MS    = 30_000;
  private readonly STALE_THRESHOLD_MS  = 2 * 60_000;   // force-reconnect after 2 min silence
  private readonly STUCK_THRESHOLD_MS  = 5 * 60_000;   // force new connectWs() if stuck disconnected

  start(): void {
    logger.info('[GRD] Starting Raydium/graduated token scanner (PumpPortal WS migration events)...');
    this.connectWs();
    this.startWatchdog();
  }

  stop(): void {
    this.stopKeepalive();
    this.ws?.close();
  }

  // ── PumpPortal WebSocket ──────────────────────────────
  private connectWs(): void {
    try {
      this.ws = new WebSocket(PP_WS_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      this.ws.on('open', () => {
        logger.info('[GRD] PumpPortal WebSocket connected — subscribing to migrations');
        this.wsConnected = true;
        this.disconnectedSince = null;
        this.reconnectDelay = 3_000;
        this.lastWsMessageAt = Date.now();
        this.ws!.send(JSON.stringify({ method: 'subscribeMigration' }));
        this.startPing();
      });

      this.ws.on('message', (raw: Buffer) => {
        this.lastWsMessageAt = Date.now();
        this.handleWsMessage(raw.toString());
      });

      this.ws.on('close', () => {
        logger.warn(`[GRD] PumpPortal WS closed — reconnecting in ${this.reconnectDelay / 1000}s`);
        this.wsConnected = false;
        if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
        this.stopPing();
        setTimeout(() => this.connectWs(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      });

      this.ws.on('error', (err) => {
        logger.error('[GRD] PumpPortal WS error', { error: err.message });
      });

    } catch (err: any) {
      logger.error('[GRD] Failed to connect PumpPortal WS', { error: err.message });
      setTimeout(() => this.connectWs(), this.reconnectDelay);
    }
  }

  // ── Ping — sends a heartbeat every 30s to keep the connection alive ──────────
  // PumpPortal responds to pings with a pong, which resets lastWsMessageAt.
  // This prevents the watchdog from triggering on genuinely quiet periods
  // (e.g. no graduations for a while) vs a truly dead socket.
  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: 'ping' }));
        logger.debug('[GRD] Ping sent');
      }
    }, this.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // ── Watchdog — runs for the lifetime of the scanner ──────────────────────────
  // Checks every 30s whether the socket has gone silent beyond STALE_THRESHOLD_MS.
  // If stale, calls ws.terminate() (hard close) which fires the 'close' event and
  // triggers the existing exponential-backoff reconnect — no duplicate logic needed.
  private startWatchdog(): void {
    this.watchdogInterval = setInterval(() => {
      const now = Date.now();

      // Case 1: connected but silent (dead socket, no close event fired)
      if (this.wsConnected && this.lastWsMessageAt !== null) {
        const silenceMs = now - this.lastWsMessageAt;
        if (silenceMs > this.STALE_THRESHOLD_MS) {
          logger.warn(`[GRD] Watchdog: no message for ${(silenceMs / 1000).toFixed(0)}s — force-reconnecting`);
          this.ws?.terminate();
        }
        return;
      }

      // Case 2: disconnected and stuck (reconnects not recovering — TCP half-open / server unreachable)
      if (!this.wsConnected && this.disconnectedSince !== null) {
        const stuckMs = now - this.disconnectedSince;
        if (stuckMs > this.STUCK_THRESHOLD_MS) {
          logger.warn(`[GRD] Watchdog: disconnected for ${(stuckMs / 1000).toFixed(0)}s — forcing new connection`);
          this.disconnectedSince = now;   // reset so we don't spam
          this.ws?.terminate();
          void this.connectWs();
        }
      }
    }, this.PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    this.stopPing();
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  // ── Migration event handler — queue immediately, evaluate later ──
  private handleWsMessage(raw: string): void {
    try {
      const data = JSON.parse(raw);

      // PumpPortal migration event — token graduated from bonding curve to Raydium
      const isMigration = data.txType === 'migrate'
        || data.txType === 'migration'
        || (data.mint && data.pool === 'raydium');

      if (!isMigration || !data.mint) return;

      const mint: string = data.mint;

      if (this.seenMints.has(mint)) {
        logger.debug(`[GRD] ${mint} — already seen, skipping`);
        return;
      }
      this.seenMints.add(mint);

      if (this.seenMints.size > 5_000) {
        const arr = Array.from(this.seenMints);
        this.seenMints = new Set(arr.slice(-2_000));
      }

      const ticker = data.symbol ? (data.symbol as string).toUpperCase() : mint;
      const name: string = data.name ?? ticker;

      const token: NewToken = {
        mintAddress:   mint,
        name,
        ticker,
        description:   data.description ?? '',
        creatorWallet: data.traderPublicKey ?? data.creator ?? '',
        createdAt:     new Date(),
        pumpfunUrl:    `https://pump.fun/${mint}`,
      };

      // Placeholder on-chain data — real data fetched at evaluation time
      const placeholder: TokenOnChainData = {
        mintAddress:       mint,
        liquidityUsd:      0,
        volumeUsd24h:      0,
        holderCount:       0,
        priceUsd:          0,
        marketCapUsd:      0,
        lpLocked:          false,
        devHoldingPercent: 0,
        ageMinutes:        0,
        dexscreenerUrl:    `https://dexscreener.com/solana/${mint}`,
      };

      this.emit('token', token, placeholder);
    } catch {
      // Non-JSON frames — ignore
    }
  }

  getHealth(): WsHealth {
    const lastMessageMinutesAgo = this.lastWsMessageAt === null
      ? null
      : (Date.now() - this.lastWsMessageAt) / 60_000;

    return {
      source: 'GRD',
      wsConnected: this.wsConnected,
      lastMessageAt: this.lastWsMessageAt,
      lastMessageMinutesAgo,
      reconnectDelay: this.reconnectDelay,
    };
  }

  // ── Helius: unique token holder count ────────────────────────────────────────
  // Helius DAS getTokenAccounts — `result.total` equals items in the current page,
  // not the grand total. We fetch up to 1000 accounts and count token_accounts.length.
  // Falls back to DexScreener buy-tx count on any error so the pipeline never stalls.
  private async fetchHeliusHolderCount(mint: string): Promise<number | null> {
    try {
      const res = await axios.post(
        config.solana.rpcUrl,
        {
          jsonrpc: '2.0',
          id:      'holder-count',
          method:  'getTokenAccounts',
          params:  { page: 1, limit: 1000, mint },
        },
        { timeout: 5_000 },
      );
      const accounts = res.data?.result?.token_accounts;
      return Array.isArray(accounts) ? accounts.length : null;
    } catch (err: any) {
      logger.debug(`[GRD] Helius holder count failed for ${mint}: ${err.message}`);
      return null;
    }
  }

  // ── Extended result type includes token metadata from DexScreener ────────────
  private buildPairResult(
    mint: string,
    pair: any,
    holderCount: number,
  ): { onChain: TokenOnChainData; name: string; symbol: string } {
    const createdAt  = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date();
    const ageMinutes = (Date.now() - createdAt.getTime()) / 60_000;
    const liq        = pair.liquidity?.usd ?? 0;
    const dexLabel   = pair.dexId ?? 'unknown';

    logger.info(`[GRD] Using ${dexLabel} pair — liq $${liq.toFixed(0)}, age ${ageMinutes.toFixed(1)}m, holders ${holderCount}`);

    return {
      name:   pair.baseToken?.name   ?? 'Unknown',
      symbol: pair.baseToken?.symbol ?? '',
      onChain: {
        mintAddress:       mint,
        liquidityUsd:      liq,
        volumeUsd24h:      pair.volume?.h24 ?? 0,
        holderCount,
        priceUsd:          parseFloat(pair.priceUsd ?? '0'),
        marketCapUsd:      pair.marketCap   ?? 0,
        lpLocked:          false,
        devHoldingPercent: 0,
        ageMinutes,
        lastTradeMinutesAgo: parseLastTradeMinutesAgo(pair),
        dexscreenerUrl:    pair.url ?? `https://dexscreener.com/solana/${mint}`,
      },
    };
  }

  // ── DexScreener fetch — accepts Raydium OR Pump.fun AMM ──────────────────────
  // Pump.fun now graduates tokens to either Raydium or its own AMM. Both are
  // tradeable via Jupiter. We prefer Raydium if available, then Pump.fun AMM,
  // then any other Solana DEX. Called at evaluation time (15 min after migration).
  // Returns null when NO pair exists yet.
  async fetchRaydiumData(mint: string): Promise<{ onChain: TokenOnChainData; name: string; symbol: string } | null> {
    try {
      const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 8_000 });
      const pairs = res.data?.pairs;

      if (!pairs || pairs.length === 0) {
        logger.info(`[GRD] DexScreener: no pairs at all for ${mint}`);
        return null;
      }

      const solanaPairs = pairs.filter((p: any) => p.chainId === 'solana');
      if (solanaPairs.length === 0) return null;

      const dexIds = [...new Set(solanaPairs.map((p: any) => p.dexId))];
      logger.info(`[GRD] DexScreener: ${solanaPairs.length} Solana pair(s) on: ${dexIds.join(', ')}`);

      // Preference order: raydium > pump-fun AMM > anything else
      const ranked = [
        ...solanaPairs.filter((p: any) => p.dexId === 'raydium'),
        ...solanaPairs.filter((p: any) => p.dexId === 'pump-fun' || p.dexId === 'pumpfun'),
        ...solanaPairs.filter((p: any) => p.dexId !== 'raydium' && p.dexId !== 'pump-fun' && p.dexId !== 'pumpfun'),
      ];

      // Pick highest liquidity from preferred group
      const pair = ranked.sort(
        (a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
      )[0];

      // Fetch unique holder count from Helius; fall back to DexScreener buy-tx count
      const heliusCount = await this.fetchHeliusHolderCount(mint);
      const holderCount = heliusCount !== null
        ? heliusCount
        : (pair.txns?.h24?.buys ?? 0);

      if (heliusCount !== null) {
        logger.info(`[GRD] Helius holder count for ${mint}: ${heliusCount} unique wallets`);
      } else {
        logger.debug(`[GRD] Helius unavailable — using DexScreener buy-tx count (${pair.txns?.h24?.buys ?? 0}) for ${mint}`);
      }

      return this.buildPairResult(mint, pair, holderCount);
    } catch (err: any) {
      logger.warn(`[GRD] DexScreener fetch failed for ${mint}`, { error: err.message });
      return null;
    }
  }

  // Also used by position monitor for price polling — accepts any Solana DEX
  async getCurrentPriceUsd(mint: string): Promise<number | null> {
    try {
      const result = await this.fetchRaydiumData(mint);
      return result?.onChain.priceUsd ?? null;
    } catch {
      return null;
    }
  }
}
