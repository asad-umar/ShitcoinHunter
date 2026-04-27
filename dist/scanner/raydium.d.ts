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
import EventEmitter from 'events';
import { TokenOnChainData } from '../types';
export declare class RaydiumScanner extends EventEmitter {
    private seenMints;
    private pollInterval;
    start(): void;
    stop(): void;
    private poll;
    private processGraduated;
    fetchRaydiumData(mint: string): Promise<TokenOnChainData | null>;
    getCurrentPriceUsd(mint: string): Promise<number | null>;
}
//# sourceMappingURL=raydium.d.ts.map