# Solana Shitcoin Hunter

A bot that scans Solana for new tokens launched on Pump.fun, uses Grok (xAI) to assess social momentum on X in real-time, and auto-trades via Jupiter DEX with automatic 2x take profit and stop loss.

## Architecture

```
Pump.fun (every 30s)
    ↓
Fast rug filter (liquidity, holders)
    ↓
Grok xAI analysis (X/Twitter sentiment, KOLs, narrative)
    ↓
Vibe score 0-10
    ↓
Score ≥ 7 → BUY via Jupiter
Score 4-6 → Watchlist (re-check in 5 min)
Score < 4 → Ignore
    ↓
Position monitor (every 10s)
    ├── 2x price → SELL (take profit)
    ├── 0.5x price → SELL (stop loss)
    └── 30 min → SELL (timeout)
```

## Setup

### 1. Prerequisites

- Node.js 18+
- A Solana wallet with some SOL
- API keys for Helius, xAI (Grok), and Telegram

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your actual keys:

| Variable | Where to get it |
|---|---|
| `WALLET_PRIVATE_KEY` | Export from Phantom/Solflare as base58 |
| `HELIUS_RPC_URL` | helius.xyz — free tier works |
| `XAI_API_KEY` | console.x.ai |
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | @userinfobot on Telegram |

### 4. Start in dry run mode first

```bash
# Make sure DRY_RUN=true in .env
npm run dev
```

Watch the logs and Telegram alerts for a few hours. When you're happy with the signals, set `DRY_RUN=false`.

### 5. Go live

```bash
# Build
npm run build

# Run
npm start

# Or with auto-restart
npm run watch
```

## Configuration

| Setting | Default | Description |
|---|---|---|
| `TRADE_AMOUNT_SOL` | 0.1 | SOL per trade |
| `MIN_VIBE_SCORE` | 7 | Minimum Grok score to buy (0-10) |
| `TAKE_PROFIT_MULTIPLIER` | 2 | Sell at 2x entry price |
| `STOP_LOSS_MULTIPLIER` | 0.5 | Sell if down 50% |
| `MAX_HOLD_MINUTES` | 30 | Force sell after 30 min regardless |
| `SLIPPAGE_BPS` | 300 | 3% slippage tolerance |
| `MAX_OPEN_POSITIONS` | 3 | Max simultaneous positions |
| `MAX_TOTAL_EXPOSURE_SOL` | 0.5 | Total SOL at risk cap |
| `DRY_RUN` | true | Simulate without real trades |

## How the vibe score works

Grok searches X in real-time for the token ticker and contract address, then scores 0-10 based on:

- **9-10**: KOL with 100k+ followers posted, strong narrative, velocity exploding, zero red flags
- **7-8**: Multiple KOLs or one big one, clear meme angle, rising fast
- **5-6**: Some chatter, decent narrative — goes to watchlist
- **3-4**: Weak story, flat velocity — ignored
- **0-2**: Dead on X, or rug signals in replies — hard veto

## Risk warnings

- Shitcoins are extremely high risk. Most go to zero.
- This bot can and will lose money. Start with the smallest amounts you're willing to lose entirely.
- Always run in DRY_RUN mode first to validate signals before committing real funds.
- Pump.fun launches ~5,000-10,000 tokens daily. Most are scams.
- This is not financial advice.

## Project structure

```
src/
├── index.ts              # Main orchestrator
├── config.ts             # Environment config
├── types.ts              # Shared TypeScript types
├── logger.ts             # Winston logger
├── scanner/
│   ├── pumpfun.ts        # Pump.fun new token poller
│   └── onchain.ts        # DexScreener data fetcher + rug filter
├── grok/
│   └── analyzer.ts       # xAI Grok social sentiment analysis
├── trader/
│   ├── jupiter.ts        # Jupiter DEX buy/sell execution
│   └── positions.ts      # Position tracking + TP/SL/timeout
├── monitor/
│   └── watchlist.ts      # Borderline token re-check queue
└── alerts/
    └── telegram.ts       # Telegram notifications
```
