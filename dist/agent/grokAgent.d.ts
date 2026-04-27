/**
 * GrokAgent — single lean Grok call, only fires after PreFilter passes
 *
 * The two-step planning+decision loop is replaced with one combined call.
 * Prompt is trimmed to ~500 input tokens. Output capped at 400 tokens.
 * At ~50 calls/day this costs ~$0.06/day in tokens.
 */
import { NewToken, TokenOnChainData, AgentDecision } from '../types';
import { TradeMemory } from '../memory/tradeMemory';
export declare class GrokAgent {
    private memory;
    private readonly headers;
    private readonly SYSTEM_PROMPT;
    constructor(memory: TradeMemory);
    evaluate(token: NewToken, onChain: TokenOnChainData): Promise<AgentDecision>;
    private buildPrompt;
    private callGrok;
    private parseDecision;
    private deadDecision;
}
//# sourceMappingURL=grokAgent.d.ts.map