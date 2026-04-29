/**
 * GrokAgent — evaluates tokens in a single batched Grok call
 *
 * All tokens that pass PreFilter are collected and sent to Grok in one
 * request. Grok searches X for each ticker simultaneously and returns a
 * JSON array of decisions — one per token, in the same order.
 *
 * Single-item batches still go through the same path (no separate code).
 * Max batch size is enforced by the caller (index.ts: GROK_BATCH_MAX).
 */

import axios from 'axios';
import { NewToken, TokenOnChainData, AgentDecision } from '../types';
import { config } from '../config';
import { logger } from '../logger';
import { TradeMemory } from '../memory/tradeMemory';

export interface BatchItem {
  token:   NewToken;
  onChain: TokenOnChainData;
}

export class GrokAgent {
  private readonly headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.grok.apiKey}`,
  };

  private readonly SYSTEM_PROMPT =
    'Solana memecoin trading agent. Real-time X access. Blunt, fast, accurate. JSON only.';

  constructor(private memory: TradeMemory) {}

  // ── Public: evaluate a batch of tokens in one call ───
  async evaluateBatch(items: BatchItem[]): Promise<AgentDecision[]> {
    if (items.length === 0) return [];

    const prompt = this.buildBatchPrompt(items);
    // Allow ~400 tokens per decision (more room with full descriptions and 3-token batches)
    const maxTokens = Math.min(4000, items.length * 400 + 100);

    try {
      const raw = await this.callGrok(prompt, maxTokens);
      return this.parseBatchDecisions(raw, items);
    } catch (err: any) {
      logger.error(`[GrokAgent] Batch call failed`, { error: err.message });
      return items.map((item) => this.deadDecision(item.token.ticker));
    }
  }

  // ── Batch prompt — one prompt for N tokens ───────────
  private buildBatchPrompt(items: BatchItem[]): string {
    const recentTrades = this.memory.getRecentTrades(3);
    const tradeContext = recentTrades.length > 0
      ? recentTrades.map((t) => `${t.ticker}:${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent.toFixed(0)}%`).join(' ')
      : 'none';

    const tokenList = items
      .map(({ token, onChain }, i) => {
        const desc = token.description;
        return (
          `${i + 1}. $${token.ticker} | Name: "${token.name}" | Mint: ${token.mintAddress}\n` +
          `   Description: "${desc}"\n` +
          `   Liq:$${onChain.liquidityUsd.toFixed(0)} MCap:$${onChain.marketCapUsd.toFixed(0)} ` +
          `Age:${Math.round(onChain.ageMinutes)}m Buys:${onChain.holderCount}`
        );
      })
      .join('\n\n');

    const schemaObj =
      `{"ticker":"SYMBOL","action":"BUY"|"WATCHLIST"|"SKIP",` +
      `"confidence_percent":0-100,"is_scam":bool,"scam_confidence_percent":0-100,` +
      `"narrative":"<20 words","kol_spotted":bool,"kol_names":[],"kol_recent":bool,` +
      `"sentiment":"moon"|"hype"|"neutral"|"sus"|"rug"|"dead",` +
      `"velocity":"exploding"|"rising"|"flat"|"dead","red_flags":[],` +
      `"cross_platform":bool,"vibe_score":0-10,` +
      `"narrative_originality":0-10,"is_derivative_pun":bool,` +
      `"one_liner":"<15 words","raw_mention_count":0,"reasoning":"<30 words"}`;

    const prompt =
      `You are evaluating ${items.length} freshly graduated Solana pump.fun memecoin(s). ` +
      `These tokens are minutes-to-hours old — they will NOT have token-specific tweets yet. Focus on the META, not the token.\n\n` +
      `For each token perform THREE searches:\n\n` +
      `SEARCH 1 — META/THEME TRENDING (LAST 48 HOURS ONLY): Search X for the core theme or narrative of the token name ` +
      `(e.g. for "Brett by Matt Furie" search "Brett Pepe"; for "Dank Doge" search "doge meme"). ` +
      `CRITICAL: Only count activity from the LAST 48 HOURS. A KOL tweet from weeks or months ago about this meta ` +
      `is NOT a signal — these tokens are brand new and require current momentum. ` +
      `Set kol_recent:true only if a KOL posted about this meta within the last 48 hours. ` +
      `A meta with old KOL history but no recent posts scores the same as no KOL history. ` +
      `Look for: trending meme formats this week, viral moments from the last 2 days, active CT discourse today. ` +
      `A recycled or stale meta (generic clone with no fresh angle, no recent posts) scores low. ` +
      `A meta tied to something happening RIGHT NOW scores high.\n\n` +
      `SEARCH 2 — TIKTOK VIRAL CHECK: Search the web for recent TikTok content about this theme/character. ` +
      `Is it currently going viral on TikTok? Look for high view counts, trending sounds, duet chains, ` +
      `or creators using this meme format. No TikTok presence = neutral (expected for obscure memes). ` +
      `Active TikTok trend = strong bullish signal. Set cross_platform:true if found.\n\n` +
      `SEARCH 3 — RUG CHECK: Search X for the exact mint address. ` +
      `Flag only credible warnings from real accounts. No results = clean (expected for new tokens).\n\n` +
      `TOKENS:\n${tokenList}\n\n` +
      `Recent bot trades: ${tradeContext}\n` +
      `Strategy: ${this.memory.strategyMode} | Threshold: ${this.memory.vibeThreshold}/10\n\n` +
      `SCORING GUIDE:\n` +
      `vibe_score reflects current momentum of the meta RIGHT NOW (last 48h), weighted by originality:\n` +
      `- vibe 8-10: Original meta actively trending on CT in the last 48h — first-of-kind narrative, ` +
      `unique angle or self-aware twist, KOLs posting THIS WEEK, not a clone of anything\n` +
      `- vibe 6-7: Recognisable theme with some recent activity (last 48h), creative spin on existing meta\n` +
      `- vibe 3-5: Stale/recycled meta, no recent KOL posts, generic clone, or pun mashup\n` +
      `- vibe 0-2: Dead meta, obvious derivative with no life, zero recent activity\n\n` +
      `narrative_originality: Rate how original this narrative is vs what already exists:\n` +
      `- 8-10: Unique concept, self-aware twist, first token of this specific meta\n` +
      `- 5-7: Recognisable theme with a creative spin\n` +
      `- 0-4: Generic clone (30th TRUMP derivative), pun mashup of two memes (BEETRUMP, DBEET), ` +
      `or recycled character with no twist\n\n` +
      `is_derivative_pun: true if the token name/concept is a mashup or pun combining two existing memes/trends ` +
      `(e.g. BEETRUMP = bee + Trump, DBEET = doge + beet, TRUMPCOIN = generic Trump clone). ` +
      `These are exit-liquidity traps — mark them true even if they have KOL backing.\n\n` +
      `KOL NOTE: KOL backing is data, NOT a buy signal. kol_spotted records whether any KOL has EVER mentioned ` +
      `this meta. kol_recent records whether a KOL posted within the last 48 hours. ` +
      `Old KOL history provides zero edge — the market has already priced it in.\n\n` +
      `scam_confidence_percent: pump.fun tokens are inherently speculative — only flag HIGH if you find ` +
      `actual rug warnings, honeypot reports, or dev dump evidence for THIS contract. ` +
      `Being new or unverified is NOT a scam signal.\n\n` +
      `BUY only if: scam_confidence_percent<15 AND vibe_score>=${this.memory.vibeThreshold} ` +
      `AND narrative_originality>=7 AND is_derivative_pun===false.\n\n` +
      `Return a JSON array with exactly ${items.length} objects in the same order as the tokens above:\n` +
      `[${schemaObj},...]\n` +
      `JSON only, no other text.`;

    logger.info('[GrokAgent] ── Finalized prompt ──────────────────────────\n' + prompt + '\n─────────────────────────────────────────────────────');

    return prompt;
  }

  // ── HTTP call to Grok ─────────────────────────────────
  private async callGrok(prompt: string, maxTokens: number): Promise<string> {
    const response = await axios.post(
      `${config.grok.baseUrl}/chat/completions`,
      {
        model: config.grok.model,
        messages: [
          { role: 'system', content: this.SYSTEM_PROMPT },
          { role: 'user',   content: prompt },
        ],
        temperature: 0.1,
        max_tokens:  maxTokens,
      },
      { headers: this.headers, timeout: 30_000 },
    );

    return response.data.choices?.[0]?.message?.content ?? '';
  }

  // ── Parse array response ──────────────────────────────
  private parseBatchDecisions(raw: string, items: BatchItem[]): AgentDecision[] {
    try {
      const clean  = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(clean);

      if (!Array.isArray(parsed)) {
        throw new Error(`Expected JSON array, got ${typeof parsed}`);
      }

      return items.map((item, i) => {
        const p = parsed[i];
        if (!p) {
          logger.warn(`[GrokAgent] No decision at index ${i} for $${item.token.ticker}`);
          return this.deadDecision(item.token.ticker);
        }
        return this.parseDecisionObject(p, item.token.ticker);
      });
    } catch (err: any) {
      logger.warn(`[GrokAgent] Batch parse failed: ${err.message} — raw: ${raw.slice(0, 200)}`);
      return items.map((item) => this.deadDecision(item.token.ticker));
    }
  }

  // ── Shared parser for a single decision object ────────
  private parseDecisionObject(p: any, ticker: string): AgentDecision {
    try {
      const scamPct = Math.min(100, Math.max(0, Number(p.scam_confidence_percent) || 100));

      let action: AgentDecision['action'] = p.action ?? 'SKIP';
      if (scamPct >= 15 && action === 'BUY') {
        action = 'SKIP';
        logger.info(`[GrokAgent] $${ticker} BUY→SKIP (scam ${scamPct}%)`);
      }

      return {
        action,
        confidencePercent:     Math.min(100, Math.max(0, Number(p.confidence_percent) || 0)),
        isScam:                Boolean(p.is_scam),
        scamConfidencePercent: scamPct,
        narrative:             p.narrative ?? '',
        kolSpotted:            Boolean(p.kol_spotted),
        kolNames:              Array.isArray(p.kol_names) ? p.kol_names : [],
        kolRecent:             Boolean(p.kol_recent),
        sentiment:             p.sentiment ?? 'dead',
        velocity:              p.velocity  ?? 'dead',
        redFlags:              Array.isArray(p.red_flags) ? p.red_flags : [],
        crossPlatform:         Boolean(p.cross_platform),
        vibeScore:             Math.min(10, Math.max(0, Number(p.vibe_score) || 0)),
        narrativeOriginality:  Math.min(10, Math.max(0, Number(p.narrative_originality) || 0)),
        isDerivativePun:       Boolean(p.is_derivative_pun),
        oneLiner:              p.one_liner ?? '',
        rawMentionCount:       Number(p.raw_mention_count) || 0,
        dataFetched:           ['x_search', 'dexscreener'],
        reasoning:             p.reasoning ?? '',
      };
    } catch {
      logger.warn(`[GrokAgent] Failed to parse decision object for $${ticker}`);
      return this.deadDecision(ticker);
    }
  }

  private deadDecision(ticker = 'unknown'): AgentDecision {
    logger.warn(`[GrokAgent] Using dead decision for $${ticker}`);
    return {
      action:                'SKIP',
      confidencePercent:     0,
      isScam:                true,
      scamConfidencePercent: 100,
      narrative:             'API error',
      kolSpotted:            false,
      kolNames:              [],
      kolRecent:             false,
      sentiment:             'dead',
      velocity:              'dead',
      redFlags:              ['Grok API failed'],
      crossPlatform:         false,
      vibeScore:             0,
      narrativeOriginality:  0,
      isDerivativePun:       true,
      oneLiner:              'Skip — no data',
      rawMentionCount:       0,
      dataFetched:           [],
      reasoning:             'API failure',
    };
  }
}
