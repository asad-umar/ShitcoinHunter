export declare const config: {
    solana: {
        rpcUrl: string;
        heliusApiKey: string;
        walletPrivateKey: string;
    };
    grok: {
        apiKey: string;
        model: string;
        baseUrl: string;
    };
    anthropic: {
        apiKey: string;
        opusModel: string;
        sonnetModel: string;
    };
    telegram: {
        botToken: string;
        chatId: string;
    };
    trading: {
        maxBuyUsd: number;
        takeProfitUsd: number;
        stopLossUsd: number;
        maxHoldMinutes: number;
        slippageBps: number;
        maxOpenPositions: number;
        minVibeScore: number;
        minConfidencePercent: number;
        maxScamConfidencePercent: number;
        dryRun: boolean;
    };
    memory: {
        filePath: string;
        reflectionFilePath: string;
        consecutiveLossLimit: number;
    };
};
export declare const scannerMode: "pf" | "grd";
export declare const executionMode: "paper" | "real";
//# sourceMappingURL=config.d.ts.map