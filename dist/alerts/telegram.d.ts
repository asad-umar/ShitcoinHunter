/**
 * TelegramAlerter — all Telegram messages
 *
 * Every trade message includes:
 *   - Mode-appropriate chart link (pump.fun for PF, DexScreener for GRD)
 *   - Token contract address as copyable code block
 *   - Paper vs real execution tag
 *   - Scanner mode tag (PF / GRD)
 */
import { Position, ScoredToken, TradeResult } from '../types';
import type { ScannerMode, ExecutionMode } from '../modes/modeManager';
export declare class TelegramAlerter {
    private bot;
    private chatId;
    private scannerMode;
    private executionMode;
    constructor();
    setModes(scanner: ScannerMode, execution: ExecutionMode): void;
    private modeTag;
    private chartLink;
    private mintLine;
    private sentimentEmoji;
    sendSignalAlert(scored: ScoredToken): Promise<void>;
    sendBuyAlert(position: Position, scored: ScoredToken): Promise<void>;
    sendSellAlert(position: Position, result: TradeResult): Promise<void>;
    sendRejectionAlert(token: {
        ticker: string;
        name: string;
        mintAddress: string;
    }, stage: string, reason: string, heuristicScore?: number): Promise<void>;
    sendGrokRejectionAlert(token: {
        ticker: string;
        name: string;
        mintAddress: string;
    }, onChain: {
        liquidityUsd: number;
        marketCapUsd: number;
        dexscreenerUrl: string;
    }, action: string, reason: string, vibeScore: number, scamPct: number): Promise<void>;
    sendError(message: string): Promise<void>;
    sendStartup(walletAddress: string, solBalance: number): Promise<void>;
    sendCycleSummary(message: string): Promise<void>;
    private send;
}
//# sourceMappingURL=telegram.d.ts.map