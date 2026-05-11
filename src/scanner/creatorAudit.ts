import axios from 'axios';
import { logger } from '../logger';

export interface CreatorRisk {
  wallet: string;
  totalCreated: number;
  recentCreated: number;   // last 7 days
  graduated: number;
  abandoned: number;       // tokens with no activity / effectively dead
  rugRate: number;         // 0-1: fraction of prior tokens that appear to have rugged
  summary: string;         // pre-formatted for Grok prompt injection
}

interface PFCoin {
  mint: string;
  created_timestamp?: number;
  complete?: boolean;      // true = graduated
  virtual_sol_reserves?: number;
  market_cap?: number;
  last_trade_unix_time?: number;
}

const PF_API = 'https://frontend-api.pump.fun/coins';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function auditCreator(wallet: string): Promise<CreatorRisk | null> {
  if (!wallet || wallet.length < 32) return null;

  try {
    const res = await axios.get(`${PF_API}`, {
      params: { creator: wallet, limit: 50, offset: 0 },
      timeout: 8_000,
    });

    const coins: PFCoin[] = Array.isArray(res.data) ? res.data : [];
    if (coins.length === 0) {
      return buildRisk(wallet, 0, 0, 0, 0);
    }

    const now = Date.now();
    let recentCreated = 0;
    let graduated = 0;
    let abandoned = 0;

    for (const coin of coins) {
      const createdMs = coin.created_timestamp
        ? (coin.created_timestamp > 1_000_000_000_000 ? coin.created_timestamp : coin.created_timestamp * 1000)
        : 0;

      if (createdMs && (now - createdMs) < SEVEN_DAYS_MS) recentCreated++;
      if (coin.complete) graduated++;

      // "abandoned": last trade > 48h ago and market cap effectively zero
      const lastTradeMs = coin.last_trade_unix_time
        ? (coin.last_trade_unix_time > 1_000_000_000_000 ? coin.last_trade_unix_time : coin.last_trade_unix_time * 1000)
        : 0;
      const mcap = coin.market_cap ?? 0;
      const stale = lastTradeMs ? (now - lastTradeMs) > 2 * 24 * 60 * 60 * 1000 : true;
      if (stale && mcap < 1000 && !coin.complete) abandoned++;
    }

    return buildRisk(wallet, coins.length, recentCreated, graduated, abandoned);
  } catch (err: any) {
    logger.debug(`[CreatorAudit] Failed for ${wallet.slice(0, 8)}…: ${err.message}`);
    return null;
  }
}

function buildRisk(
  wallet: string,
  total: number,
  recent: number,
  graduated: number,
  abandoned: number,
): CreatorRisk {
  const rugRate = total > 0 ? abandoned / total : 0;

  let summary: string;
  if (total === 0) {
    summary = 'Creator: no prior tokens (wallet is new)';
  } else {
    const rugPct = (rugRate * 100).toFixed(0);
    const parts = [
      `Creator history: ${total} prior token(s)`,
      `${recent} in last 7d`,
      `${graduated} graduated`,
      `${abandoned} abandoned/rugged (${rugPct}% rug rate)`,
    ];
    if (rugRate >= 0.7 && total >= 3) parts.push('HIGH RUG RISK');
    else if (rugRate >= 0.4 && total >= 3) parts.push('ELEVATED RUG RISK');
    else if (graduated > 0) parts.push('has graduates — credible creator');
    summary = parts.join(' | ');
  }

  return { wallet, totalCreated: total, recentCreated: recent, graduated, abandoned, rugRate, summary };
}
