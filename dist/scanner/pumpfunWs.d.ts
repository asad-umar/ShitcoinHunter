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
import EventEmitter from 'events';
import { TokenOnChainData } from '../types';
export interface PFTokenData extends TokenOnChainData {
    bondingCurveProgress: number;
    graduated: boolean;
    virtualSolReserves: number;
    virtualTokenReserves: number;
}
export declare class PumpFunWsScanner extends EventEmitter {
    private ws;
    private seenMints;
    private restFallbackInterval;
    private wsConnected;
    private reconnectDelay;
    private lastRestCheck;
    start(): void;
    stop(): void;
    private connectWs;
    private handleWsMessage;
    private handleNewCoin;
    fetchPFData(mint: string, coinHint?: any): Promise<PFTokenData | null>;
    private restFallback;
    updateSolPrice(priceUsd: number): void;
}
//# sourceMappingURL=pumpfunWs.d.ts.map