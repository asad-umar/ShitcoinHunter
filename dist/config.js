"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executionMode = exports.scannerMode = exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function required(key) {
    const val = process.env[key];
    if (!val)
        throw new Error(`Missing required env var: ${key}`);
    return val;
}
function optional(key, fallback) {
    return process.env[key] ?? fallback;
}
exports.config = {
    solana: {
        rpcUrl: required('HELIUS_RPC_URL'),
        heliusApiKey: required('HELIUS_API_KEY'),
        walletPrivateKey: required('WALLET_PRIVATE_KEY'),
    },
    grok: {
        apiKey: required('XAI_API_KEY'),
        model: 'grok-2-latest',
        baseUrl: 'https://api.x.ai/v1',
    },
    anthropic: {
        apiKey: required('ANTHROPIC_API_KEY'),
        opusModel: 'claude-opus-4-5-20251101', // used for daily reflection
        sonnetModel: 'claude-sonnet-4-5-20251022', // used for intra-day decisions
    },
    telegram: {
        botToken: required('TELEGRAM_BOT_TOKEN'),
        chatId: required('TELEGRAM_CHAT_ID'),
    },
    trading: {
        // USD-denominated limits (items 2 & 3)
        maxBuyUsd: parseFloat(optional('MAX_BUY_USD', '10')), // never spend more than $10
        takeProfitUsd: parseFloat(optional('TAKE_PROFIT_USD', '20')), // sell when position worth $20
        stopLossUsd: parseFloat(optional('STOP_LOSS_USD', '5')), // sell when worth $5
        maxHoldMinutes: parseInt(optional('MAX_HOLD_MINUTES', '30')),
        slippageBps: parseInt(optional('SLIPPAGE_BPS', '300')),
        maxOpenPositions: parseInt(optional('MAX_OPEN_POSITIONS', '3')),
        // Adaptive thresholds (start values — memory will override at runtime)
        minVibeScore: parseInt(optional('MIN_VIBE_SCORE', '7')),
        minConfidencePercent: parseInt(optional('MIN_CONFIDENCE_PCT', '95')),
        maxScamConfidencePercent: parseInt(optional('MAX_SCAM_CONFIDENCE_PCT', '5')),
        dryRun: optional('DRY_RUN', 'true') === 'true',
    },
    memory: {
        filePath: optional('MEMORY_FILE', 'data/memory.json'),
        reflectionFilePath: optional('REFLECTION_DIR', 'data/reflections'),
        // How many consecutive losses before switching to conservative mode
        consecutiveLossLimit: parseInt(optional('CONSECUTIVE_LOSS_LIMIT', '3')),
    },
};
// Re-exported for convenience — actual resolution happens in modeManager.ts
exports.scannerMode = (process.env.SCANNER_MODE ?? 'pf');
exports.executionMode = (process.env.EXECUTION_MODE ?? 'paper');
//# sourceMappingURL=config.js.map