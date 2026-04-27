import { TokenOnChainData } from '../types';
export declare class OnChainFetcher {
    fetchTokenData(mintAddress: string): Promise<TokenOnChainData | null>;
    private fetchDexScreener;
    isRugged(data: TokenOnChainData): {
        rugged: boolean;
        reason: string;
    };
    getCurrentPriceUsd(mintAddress: string): Promise<number | null>;
}
//# sourceMappingURL=onchain.d.ts.map