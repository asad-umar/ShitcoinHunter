import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalMaybe(key: string): string | undefined {
  return process.env[key];
}

export const config = {
  solana: {
    rpcUrl: required('HELIUS_RPC_URL'),
    heliusApiKey: required('HELIUS_API_KEY'),
    walletPrivateKey: required('WALLET_PRIVATE_KEY'),
  },
  grok: {
    apiKey: required('XAI_API_KEY'),
    model: 'grok-4-1-fast-reasoning',
    baseUrl: 'https://api.x.ai/v1',
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    opusModel: 'claude-opus-4-5-20251101',     // used for daily reflection
    sonnetModel: 'claude-sonnet-4-5-20251022', // used for intra-day decisions
  },
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    chatId: required('TELEGRAM_CHAT_ID'),
    alertBotToken: optionalMaybe('TELEGRAM_ALERT_BOT_TOKEN'),
    alertChatId: optionalMaybe('TELEGRAM_ALERT_CHAT_ID'),
  },
  trading: {
    // USD-denominated limits (items 2 & 3)
    maxBuyUsd: parseFloat(optional('MAX_BUY_USD', '10')),       // never spend more than $10
    takeProfitUsd: parseFloat(optional('TAKE_PROFIT_USD', '20')), // sell when position worth $20
    stopLossUsd: parseFloat(optional('STOP_LOSS_USD', '5')),     // sell when worth $5
    maxHoldMinutes: parseInt(optional('MAX_HOLD_MINUTES', '30')),
    slippageBps: parseInt(optional('SLIPPAGE_BPS', '300')),
    maxOpenPositions: parseInt(optional('MAX_OPEN_POSITIONS', '3')),

    // Adaptive thresholds (start values — memory will override at runtime)
    minVibeScore: parseInt(optional('MIN_VIBE_SCORE', '6')),
    minConfidencePercent: parseInt(optional('MIN_CONFIDENCE_PCT', '95')),
    maxScamConfidencePercent: parseInt(optional('MAX_SCAM_CONFIDENCE_PCT', '15')),

    dryRun: optional('DRY_RUN', 'true') === 'true',
  },
  health: {
    heartbeatMinutes: parseInt(optional('HEALTH_HEARTBEAT_MINUTES', '5')),
    heartbeatEnabled: optional('HEALTH_HEARTBEAT_ENABLED', 'true') === 'true',
    websocketStaleMinutes: parseInt(optional('HEALTH_WEBSOCKET_STALE_MINUTES', '5')),
  },
  memory: {
    filePath: optional('MEMORY_FILE', 'data/memory.json'),
    reflectionFilePath: optional('REFLECTION_DIR', 'data/reflections'),
    // How many consecutive losses before switching to conservative mode
    consecutiveLossLimit: parseInt(optional('CONSECUTIVE_LOSS_LIMIT', '3')),
  },
};

// Re-exported for convenience — actual resolution happens in modeManager.ts
export const scannerMode   = (process.env.SCANNER_MODE   ?? 'pf')    as 'pf' | 'grd';
export const executionMode = (process.env.EXECUTION_MODE ?? 'paper') as 'paper' | 'real';

// WebSocket provider for PF mode: 'ws' = Pump.fun Socket.IO, 'pp' = PumpPortal
export const wsProvider = (process.env.WS_PROVIDER ?? 'pp') as 'ws' | 'pp';

// ── Per-mode filter thresholds ────────────────────────────────────────────────
// PF = bonding curve pre-graduation (small, young tokens)
// GRD = post-graduation Raydium/PF-AMM tokens (stricter — already at ~$69k mcap)
import type { FilterThresholds } from './scanner/datafilter';

export const pfThresholds: FilterThresholds = {
  minLiquidityUsd:          parseFloat(optional('PF_MIN_LIQUIDITY_USD', '2000')),
  maxLiquidityUsd:          parseFloat(optional('PF_MAX_LIQUIDITY_USD', '500000')),
  minMarketCapUsd:          parseFloat(optional('PF_MIN_MCAP_USD',      '25000')),
  minMarketCapForRetention: parseFloat(optional('PF_MIN_MCAP_FOR_RETENTION', '5000')),
  maxMarketCapUsd:          parseFloat(optional('PF_MAX_MCAP_USD',      '5000000')),
  minBuys:                  parseInt  (optional('PF_MIN_BUYS',          '100')),
  minBuysForRetention:      parseInt  (optional('PF_MIN_BUYS_FOR_RETENTION','10')),
  minVolumeUsd:             parseFloat(optional('PF_MIN_VOLUME_USD',    '25000')),
  minVolumeForRetention:    parseFloat(optional('PF_MIN_VOLUME_FOR_RETENTION', '5000')),
  maxAgeMinutes:            parseInt  (optional('PF_MAX_AGE_MINUTES',   '0')),
  maxLastTradeMinutes:      parseInt  (optional('PF_MAX_LAST_TRADE_MINUTES', '5')),
  heuristicPassScore:       parseInt  (optional('PF_HEURISTIC_PASS_SCORE', '6')),
};

export const grdThresholds: FilterThresholds = {
  minLiquidityUsd:          parseFloat(optional('GRD_MIN_LIQUIDITY_USD', '10000')),
  maxLiquidityUsd:          parseFloat(optional('GRD_MAX_LIQUIDITY_USD', '2000000')),
  minMarketCapUsd:          parseFloat(optional('GRD_MIN_MCAP_USD',      '25000')),
  minBuys:                  parseInt  (optional('GRD_MIN_BUYS',          '100')),
  minVolumeUsd:             parseFloat(optional('GRD_MIN_VOLUME_USD',    '20000')),
  minMarketCapForRetention: parseFloat(optional('GRD_MIN_MCAP_FOR_RETENTION', '10000')),
  minBuysForRetention:      parseInt  (optional('GRD_MIN_BUYS_FOR_RETENTION','25')),
  minVolumeForRetention:    parseFloat(optional('GRD_MIN_VOLUME_FOR_RETENTION', '5000')),
  maxMarketCapUsd:          parseFloat(optional('GRD_MAX_MCAP_USD',      '10000000')),
  maxAgeMinutes:            parseInt  (optional('GRD_MAX_AGE_MINUTES',   '0')),
  maxLastTradeMinutes:      parseInt  (optional('GRD_MAX_LAST_TRADE_MINUTES', '30')),
  heuristicPassScore:       parseInt  (optional('GRD_HEURISTIC_PASS_SCORE', '6')),
};
