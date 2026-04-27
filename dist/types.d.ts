export interface NewToken {
    mintAddress: string;
    name: string;
    ticker: string;
    description: string;
    creatorWallet: string;
    createdAt: Date;
    pumpfunUrl: string;
    imageUrl?: string;
}
export interface TokenOnChainData {
    mintAddress: string;
    liquidityUsd: number;
    volumeUsd24h: number;
    holderCount: number;
    priceUsd: number;
    marketCapUsd: number;
    lpLocked: boolean;
    devHoldingPercent: number;
    ageMinutes: number;
    dexscreenerUrl: string;
}
export type DataRequest = {
    type: 'dexscreener';
    mintAddress: string;
} | {
    type: 'pumpfun_metadata';
    mintAddress: string;
} | {
    type: 'holder_distribution';
    mintAddress: string;
} | {
    type: 'twitter_search';
    query: string;
} | {
    type: 'creator_history';
    walletAddress: string;
};
export interface AgentDecision {
    action: 'BUY' | 'WATCHLIST' | 'SKIP' | 'INVESTIGATE';
    confidencePercent: number;
    isScam: boolean;
    scamConfidencePercent: number;
    narrative: string;
    kolSpotted: boolean;
    kolNames: string[];
    sentiment: 'moon' | 'hype' | 'neutral' | 'sus' | 'rug' | 'dead';
    velocity: 'exploding' | 'rising' | 'flat' | 'dead';
    redFlags: string[];
    crossPlatform: boolean;
    vibeScore: number;
    oneLiner: string;
    rawMentionCount: number;
    dataFetched: string[];
    reasoning: string;
}
export type GrokVibeResult = AgentDecision;
export interface ScoredToken {
    token: NewToken;
    onChain: TokenOnChainData;
    vibe: AgentDecision;
    finalScore: number;
    scoredAt: Date;
}
export interface Position {
    id: string;
    mintAddress: string;
    ticker: string;
    entryPriceUsd: number;
    entryPriceSol: number;
    amountUsdSpent: number;
    amountSolSpent: number;
    tokenAmount: number;
    openedAt: Date;
    status: 'open' | 'closed';
    exitPriceUsd?: number;
    exitReason?: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'timeout' | 'manual' | 'strategy_override';
    pnlUsd?: number;
    pnlPercent?: number;
    txBuy?: string;
    txSell?: string;
    highWaterMarkUsd?: number;
}
export interface TradeResult {
    success: boolean;
    txSignature?: string;
    error?: string;
    amountIn: number;
    amountOut: number;
    priceImpact?: number;
}
export interface TradeRecord {
    id: string;
    ticker: string;
    mintAddress: string;
    vibeScoreAtEntry: number;
    confidenceAtEntry: number;
    entryPriceUsd: number;
    exitPriceUsd: number;
    amountUsdSpent: number;
    pnlUsd: number;
    pnlPercent: number;
    exitReason: string;
    openedAt: string;
    closedAt: string;
    narrative: string;
    kolSpotted: boolean;
    redFlagsAtEntry: string[];
    dataSourcesUsed: string[];
}
export interface MemoryState {
    trades: TradeRecord[];
    currentVibeThreshold: number;
    currentConfidenceThreshold: number;
    strategyMode: 'normal' | 'conservative' | 'aggressive' | 'paused';
    consecutiveLosses: number;
    totalPnlUsd: number;
    lastReflectionDate: string | null;
    adaptationLog: AdaptationEntry[];
}
export interface AdaptationEntry {
    timestamp: string;
    reason: string;
    oldThreshold: number;
    newThreshold: number;
    oldStrategyMode: string;
    newStrategyMode: string;
}
export interface DailyReflection {
    date: string;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    totalPnlUsd: number;
    winRate: number;
    avgVibeScoreWinners: number;
    avgVibeScoreLosers: number;
    strategyAssessment: string;
    patternInsights: string;
    recommendedThresholdChange: number;
    recommendedStrategyMode: MemoryState['strategyMode'];
    keyLearnings: string[];
    tomorrowFocus: string;
    rawOpusResponse: string;
}
//# sourceMappingURL=types.d.ts.map