import { TradeResult } from '../types';
export declare class JupiterTrader {
    private connection;
    private wallet;
    constructor();
    get walletAddress(): string;
    buy(mintAddress: string, amountSol: number): Promise<TradeResult>;
    sell(mintAddress: string, tokenAmount: number): Promise<TradeResult>;
    sellAll(mintAddress: string): Promise<TradeResult>;
    private getQuote;
    private getSwapTransaction;
    private signAndSend;
    getTokenBalance(mintAddress: string): Promise<number>;
    getTokenDecimals(mintAddress: string): Promise<number>;
    getSolBalance(): Promise<number>;
}
//# sourceMappingURL=jupiter.d.ts.map