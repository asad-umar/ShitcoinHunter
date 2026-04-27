/**
 * DataFilter — 3-stage zero-cost funnel before any Grok call
 *
 * Stage 0: Profanity filter    — reject tokens with offensive names/tickers
 * Stage 1: Hard numeric gates  — reject on bad on-chain metrics
 * Stage 2: Heuristic score     — local signal scoring, only ≥6 passes
 */

import { NewToken, TokenOnChainData } from '../types';
import { logger } from '../logger';
import { PROFANITY } from './profanityList';

export type FilterStage = 'profanity' | 'hard_filter' | 'heuristic' | 'grok_skip' | 'passed';

export interface DataFilterResult {
  pass:            boolean;
  stage:           FilterStage;
  reason:          string;
  heuristicScore?: number;
  outcome?:        'pass' | 'reject' | 'retain';
}

// ── Threshold shape ───────────────────────────────────────────────────────────
export interface FilterThresholds {
  minLiquidityUsd:          number;
  maxLiquidityUsd:          number;
  minBuys:                  number;
  minBuysForRetention:      number;
  minMarketCapUsd:          number;
  minMarketCapForRetention: number;
  maxMarketCapUsd:          number;
  minVolumeUsd:             number;
  minVolumeForRetention:    number;
  maxAgeMinutes:            number;
  maxLastTradeMinutes:      number;
  heuristicPassScore:       number;
}

// Build a single regex for fast matching (substring / wildcard-style matching)
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROFANITY_REGEX = new RegExp(
  PROFANITY.map((w) => escapeRegex(w)).join('|'),
  'i'
);

// ── Rug / scam patterns ───────────────────────────────────────────────────────
const RUG_PATTERNS = [
  /\bairdrop\b/i, /\bgiveaway\b/i, /free\s*token/i,
  /honeypot/i, /\bpresale\b/i, /100x\s*guaranteed/i, /safe\s*moon/i,
];

// ── Meme signals (positive) ───────────────────────────────────────────────────
const MEME_SIGNALS = [
  /pepe/i, /doge/i, /shib/i, /\bcat\b/i, /\bdog\b/i, /frog/i, /meme/i,
  /\binu\b/i, /wojak/i, /chad/i, /based/i, /trump/i, /elon/i,
  /\bai\b/i, /agent/i, /\bsol\b/i, /pump/i,
];

export class DataFilter {
  private readonly t: FilterThresholds;

  constructor(thresholds: FilterThresholds) {
    this.t = thresholds;
    logger.info(
      `[DataFilter] Thresholds — mcap $${thresholds.minMarketCapUsd}–$${thresholds.maxMarketCapUsd}` +
      ` | buys >=${thresholds.minBuys}` +
      ` | vol >=$${thresholds.minVolumeUsd}` +
      ` | age ${thresholds.maxAgeMinutes > 0 ? `<=${thresholds.maxAgeMinutes}m` : 'disabled'}` +
      ` | last trade <=${thresholds.maxLastTradeMinutes}m` +
      ` | heuristic >=${thresholds.heuristicPassScore}/10`
    );
  }

  // ── Stage 0: profanity — called immediately on token arrival ─────────────────
  evaluateName(token: NewToken): DataFilterResult {
    const text = `${token.name} ${token.ticker} ${token.description}`;
    const profanityMatch = PROFANITY_REGEX.exec(text);
    if (profanityMatch) {
      const word = profanityMatch[0].toLowerCase();
      logger.info(`[DataFilter] PROFANITY $${token.ticker}: matched "${word}"`);
      return { pass: false, stage: 'profanity', reason: `Profane word detected: "${word}"` };
    }
    return { pass: true, stage: 'passed', reason: 'ok' };
  }

  // ── Stages 1 + 2: metrics — called when on-chain data is available ───────────
  evaluateMetrics(token: NewToken, onChain: TokenOnChainData, retentionRuns = 0): DataFilterResult {
    const text = `${token.name} ${token.ticker} ${token.description}`;

    const hardFail = this.hardFilter(onChain);
    if (hardFail) {
      return {
        pass:    false,
        stage:   'hard_filter',
        reason:  hardFail.reason,
        outcome: 'reject',
      };
    }

    const softFail = this.softFilter(onChain);
    if (softFail) {
      return {
        pass:    false,
        stage:   'hard_filter',
        reason:  softFail.reason,
        outcome: 'retain',
      };
    }

    const score = this.heuristicScore(token, onChain, text);
    if (score < this.t.heuristicPassScore) {
      return {
        pass:           false,
        stage:          'heuristic',
        reason:         `Heuristic score ${score}/10 < threshold ${this.t.heuristicPassScore}`,
        heuristicScore: score,
        outcome:        'reject',
      };
    }

    return { pass: true, stage: 'passed', reason: 'ok', heuristicScore: score, outcome: 'pass' };
  }

  // ── GRD-specific evaluation — no heuristic, direct threshold check ────────────
  //
  // Returns:
  //   outcome 'pass'   — all of minMarketCapUsd, minBuys, minVolumeUsd met → forward to Grok
  //   outcome 'retain' — passes retention thresholds but not main ones → keep for next iteration
  //   outcome 'reject' — fails retention thresholds or hard limits → drop
  //
  evaluateGrdMetrics(token: NewToken, onChain: TokenOnChainData): DataFilterResult {
    // Hard rejections — drop regardless of retention
    if (this.t.maxLastTradeMinutes > 0 && typeof onChain.lastTradeMinutesAgo === 'number' && onChain.lastTradeMinutesAgo > this.t.maxLastTradeMinutes)
      return { pass: false, stage: 'hard_filter', reason: `Last trade ${onChain.lastTradeMinutesAgo.toFixed(1)}m ago > ${this.t.maxLastTradeMinutes}m`, outcome: 'reject' };
    if (onChain.marketCapUsd > this.t.maxMarketCapUsd)
      return { pass: false, stage: 'hard_filter', reason: `MCap $${onChain.marketCapUsd.toFixed(0)} > max $${this.t.maxMarketCapUsd}`, outcome: 'reject' };

    // Main thresholds — all four met → forward to Grok
    if (
      onChain.marketCapUsd >= this.t.minMarketCapUsd  &&
      onChain.holderCount  >= this.t.minBuys          &&
      onChain.volumeUsd24h >= this.t.minVolumeUsd     &&
      onChain.liquidityUsd >= this.t.minLiquidityUsd
    ) {
      logger.info(
        `[DataFilter/GRD] $${token.ticker} PASS — ` +
        `mcap $${onChain.marketCapUsd.toFixed(0)} (>=$${this.t.minMarketCapUsd}) | ` +
        `buys ${onChain.holderCount} (>=${this.t.minBuys}) | ` +
        `vol $${onChain.volumeUsd24h.toFixed(0)} (>=$${this.t.minVolumeUsd}) | ` +
        `liq $${onChain.liquidityUsd.toFixed(0)} (>=$${this.t.minLiquidityUsd})`
      );
      return { pass: true, stage: 'passed', reason: 'ok', outcome: 'pass' };
    }

    // Retention thresholds — all three met → retain for next iteration
    if (
      onChain.marketCapUsd >= this.t.minMarketCapForRetention &&
      onChain.holderCount  >= this.t.minBuysForRetention      &&
      onChain.volumeUsd24h >= this.t.minVolumeForRetention
    ) {
      const gaps: string[] = [];
      if (onChain.marketCapUsd < this.t.minMarketCapUsd)  gaps.push(`mcap $${onChain.marketCapUsd.toFixed(0)} < $${this.t.minMarketCapUsd}`);
      if (onChain.holderCount  < this.t.minBuys)          gaps.push(`buys ${onChain.holderCount} < ${this.t.minBuys}`);
      if (onChain.volumeUsd24h < this.t.minVolumeUsd)     gaps.push(`vol $${onChain.volumeUsd24h.toFixed(0)} < $${this.t.minVolumeUsd}`);
      if (onChain.liquidityUsd < this.t.minLiquidityUsd)  gaps.push(`liq $${onChain.liquidityUsd.toFixed(0)} < $${this.t.minLiquidityUsd}`);
      logger.info(`[DataFilter/GRD] $${token.ticker} RETAIN — ${gaps.join(' | ')}`);
      return { pass: false, stage: 'hard_filter', reason: gaps.join(', '), outcome: 'retain' };
    }

    // Fails retention — drop
    const failing: string[] = [];
    if (onChain.marketCapUsd < this.t.minMarketCapForRetention) failing.push(`mcap $${onChain.marketCapUsd.toFixed(0)} < retention $${this.t.minMarketCapForRetention}`);
    if (onChain.holderCount  < this.t.minBuysForRetention)      failing.push(`buys ${onChain.holderCount} < retention ${this.t.minBuysForRetention}`);
    if (onChain.volumeUsd24h < this.t.minVolumeForRetention)    failing.push(`vol $${onChain.volumeUsd24h.toFixed(0)} < retention $${this.t.minVolumeForRetention}`);
    return { pass: false, stage: 'hard_filter', reason: failing.join(', '), outcome: 'reject' };
  }

  // ── Stage 1: hard numeric gates ───────────────────────────────────────────────
  private hardFilter(onChain: TokenOnChainData): { code: 'age' | 'market_cap_high' | 'stale_last_trade' | 'market_cap_too_low' | 'min_buys_too_low' | 'volume_too_low'; reason: string } | null {
    if (this.t.maxAgeMinutes > 0 && onChain.ageMinutes > this.t.maxAgeMinutes)
      return { code: 'age', reason: `Age ${onChain.ageMinutes.toFixed(0)}m > ${this.t.maxAgeMinutes}m limit` };
    if (this.t.maxLastTradeMinutes > 0 && typeof onChain.lastTradeMinutesAgo === 'number' && onChain.lastTradeMinutesAgo > this.t.maxLastTradeMinutes)
      return { code: 'stale_last_trade', reason: `Last trade ${onChain.lastTradeMinutesAgo.toFixed(1)}m ago > ${this.t.maxLastTradeMinutes}m` };
    if (onChain.marketCapUsd > this.t.maxMarketCapUsd)
      return { code: 'market_cap_high', reason: `MCap $${onChain.marketCapUsd.toFixed(0)} > $${this.t.maxMarketCapUsd}` };
    if (onChain.marketCapUsd < this.t.minMarketCapForRetention)
      return { code: 'market_cap_too_low', reason: `MCap $${onChain.marketCapUsd.toFixed(0)} < retention threshold $${this.t.minMarketCapForRetention}` };
    if (onChain.holderCount < this.t.minBuysForRetention)
      return { code: 'min_buys_too_low', reason: `Buys ${onChain.holderCount} < retention threshold ${this.t.minBuysForRetention}` };
    if (onChain.volumeUsd24h < this.t.minVolumeForRetention)
      return { code: 'volume_too_low', reason: `Volume $${onChain.volumeUsd24h.toFixed(0)} < retention threshold $${this.t.minVolumeForRetention}` };
    return null;
  }

  private softFilter(onChain: TokenOnChainData): { code: 'market_cap_low' | 'min_buys' | 'volume_low'; reason: string } | null {
    if (onChain.marketCapUsd < this.t.minMarketCapUsd)
      return { code: 'market_cap_low', reason: `MCap $${onChain.marketCapUsd.toFixed(0)} < $${this.t.minMarketCapUsd}` };
    if (onChain.holderCount < this.t.minBuys)
      return { code: 'min_buys', reason: `Buys ${onChain.holderCount} < ${this.t.minBuys}` };
    if (onChain.volumeUsd24h < this.t.minVolumeUsd)
      return { code: 'volume_low', reason: `Volume $${onChain.volumeUsd24h.toFixed(0)} < $${this.t.minVolumeUsd}` };
    return null;
  }

  // ── Stage 2: heuristic score ──────────────────────────────────────────────────
  private heuristicScore(token: NewToken, onChain: TokenOnChainData, text: string): number {
    if (RUG_PATTERNS.some((p) => p.test(text))) {
      logger.info(`[DataFilter] RUG PATTERN $${token.ticker}: matched scam signal`);
      return 0;
    }

    let score = 0;

    const buysPerMin = onChain.ageMinutes > 0 ? onChain.holderCount / onChain.ageMinutes : 0;
    if (buysPerMin >= 5)      score += 2;
    else if (buysPerMin >= 2) score += 1;

    if (onChain.ageMinutes <= 5)       score += 2;
    else if (onChain.ageMinutes <= 15) score += 1;

    const memeHits = MEME_SIGNALS.filter((p) => p.test(text)).length;
    if (memeHits >= 2)      score += 2;
    else if (memeHits >= 1) score += 1;

    const volLiqRatio = onChain.volumeUsd24h / Math.max(1, onChain.liquidityUsd);
    if (volLiqRatio >= 3)      score += 2;
    else if (volLiqRatio >= 1) score += 1;

    return Math.min(10, score);
  }

  getThresholds() { return { ...this.t }; }
  getProfanityList() { return [...PROFANITY]; }
}
