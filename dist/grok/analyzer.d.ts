import { NewToken, TokenOnChainData, GrokVibeResult } from '../types';
export declare class GrokAnalyzer {
    private readonly headers;
    analyzeToken(token: NewToken, onChain: TokenOnChainData): Promise<GrokVibeResult>;
    private buildPrompt;
    private parseGrokResponse;
    private defaultDeadResult;
}
//# sourceMappingURL=analyzer.d.ts.map