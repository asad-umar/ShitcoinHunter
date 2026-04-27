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
    // Allow ~220 tokens per decision plus a small header margin
    const maxTokens = Math.min(4000, items.length * 220 + 100);

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
        const desc = token.description.slice(0, 60);
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
      `"narrative":"<20 words","kol_spotted":bool,"kol_names":[],` +
      `"sentiment":"moon"|"hype"|"neutral"|"sus"|"rug"|"dead",` +
      `"velocity":"exploding"|"rising"|"flat"|"dead","red_flags":[],` +
      `"cross_platform":bool,"vibe_score":0-10,"one_liner":"<15 words",` +
      `"raw_mention_count":0,"reasoning":"<30 words"}`;

    const prompt =
      `You are evaluating ${items.length} freshly graduated Solana pump.fun memecoin(s). ` +
      `These tokens are minutes-to-hours old — they will NOT have token-specific tweets yet. Focus on the META, not the token.\n\n` +
      `For each token perform TWO searches on X (Twitter):\n\n` +
      `SEARCH 1 — META/THEME TRENDING: Search X for the core theme or narrative of the token name ` +
      `(e.g. for "Brett by Matt Furie" search "Brett Pepe"; for "Dank Doge" search "doge meme"). ` +
      `Is this theme/character/narrative HOT on Crypto Twitter RIGHT NOW? ` +
      `Look for: KOLs posting about this meta, trending meme formats, recent viral moments, active CT discourse. ` +
      `A recycled or stale meta (generic doge/pepe clone with no fresh angle) scores low. ` +
      `A meta tied to a current trending moment, viral meme, or active KOL narrative scores high.\n\n` +
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
      `- vibe 8-10: Meta is actively trending on CT right now, KOLs engaged, fresh narrative\n` +
      `- vibe 6-7: Meta has some recent activity, recognisable theme, moderate momentum\n` +
      `- vibe 3-5: Stale/recycled meta, no KOL interest, generic clone\n` +
      `- vibe 0-2: Dead meta, no activity, obvious scam signals\n\n` +
      `scam_confidence_percent: pump.fun tokens are inherently speculative — only flag HIGH if you find ` +
      `actual rug warnings, honeypot reports, or dev dump evidence for THIS contract. ` +
      `Being new or unverified is NOT a scam signal.\n\n` +
      `BUY only if scam_confidence_percent<15 AND vibe_score>=${this.memory.vibeThreshold}.\n\n` +
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
        sentiment:             p.sentiment ?? 'dead',
        velocity:              p.velocity  ?? 'dead',
        redFlags:              Array.isArray(p.red_flags) ? p.red_flags : [],
        crossPlatform:         Boolean(p.cross_platform),
        vibeScore:             Math.min(10, Math.max(0, Number(p.vibe_score) || 0)),
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
      sentiment:             'dead',
      velocity:              'dead',
      redFlags:              ['Grok API failed'],
      crossPlatform:         false,
      vibeScore:             0,
      oneLiner:              'Skip — no data',
      rawMentionCount:       0,
      dataFetched:           [],
      reasoning:             'API failure',
    };
  }
}
