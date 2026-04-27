"use strict";
/**
 * GrokAgent — single lean Grok call, only fires after PreFilter passes
 *
 * The two-step planning+decision loop is replaced with one combined call.
 * Prompt is trimmed to ~500 input tokens. Output capped at 400 tokens.
 * At ~50 calls/day this costs ~$0.06/day in tokens.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GrokAgent = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../logger");
class GrokAgent {
    constructor(memory) {
        this.memory = memory;
        this.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config_1.config.grok.apiKey}`,
        };
        // Cached system prompt — identical every call, xAI will cache it automatically
        this.SYSTEM_PROMPT = 'Solana memecoin trading agent. Real-time X access. Blunt, fast, accurate. JSON only.';
    }
    // ── Single combined call ──────────────────────────────
    async evaluate(token, onChain) {
        const prompt = this.buildPrompt(token, onChain);
        try {
            const raw = await this.callGrok(prompt);
            return this.parseDecision(raw, token);
        }
        catch (err) {
            logger_1.logger.error(`[GrokAgent] Call failed for $${token.ticker}`, { error: err.message });
            return this.deadDecision();
        }
    }
    // ── Tight prompt — ~500 tokens input, 400 tokens output ──
    buildPrompt(token, onChain) {
        const recentTrades = this.memory.getRecentTrades(3);
        const tradeContext = recentTrades.length > 0
            ? recentTrades.map((t) => `${t.ticker}:${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent.toFixed(0)}%`).join(' ')
            : 'none';
        // Keep description short — biggest token waste
        const desc = token.description.slice(0, 80);
        return `Search X NOW for $${token.ticker} (${token.mintAddress.slice(0, 8)}...).

${token.name} | ${desc}
Liq:$${onChain.liquidityUsd.toFixed(0)} MCap:$${onChain.marketCapUsd.toFixed(0)} Age:${Math.round(onChain.ageMinutes)}m Buys:${onChain.holderCount}

Recent bot trades: ${tradeContext}
Strategy: ${this.memory.strategyMode} | Threshold: ${this.memory.vibeThreshold}/10

Check X: KOLs? Sentiment? Velocity? Rug signals?
BUY only if scam_confidence_percent<5 AND vibe_score>=${this.memory.vibeThreshold}.

JSON only:
{"action":"BUY"|"WATCHLIST"|"SKIP","confidence_percent":0-100,"is_scam":bool,"scam_confidence_percent":0-100,"narrative":"<20 words","kol_spotted":bool,"kol_names":[],"sentiment":"moon"|"hype"|"neutral"|"sus"|"rug"|"dead","velocity":"exploding"|"rising"|"flat"|"dead","red_flags":[],"cross_platform":bool,"vibe_score":0-10,"one_liner":"<15 words","raw_mention_count":0,"reasoning":"<30 words"}`;
    }
    // ── Grok call — single short round trip ──────────────
    async callGrok(prompt) {
        const response = await axios_1.default.post(`${config_1.config.grok.baseUrl}/chat/completions`, {
            model: config_1.config.grok.model,
            messages: [
                { role: 'system', content: this.SYSTEM_PROMPT },
                { role: 'user', content: prompt },
            ],
            temperature: 0.1, // low = consistent JSON, less rambling
            max_tokens: 400, // was 800 — strict cap
        }, { headers: this.headers, timeout: 20000 });
        return response.data.choices?.[0]?.message?.content ?? '';
    }
    // ── Parsing ───────────────────────────────────────────
    parseDecision(raw, token) {
        try {
            const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
            const p = JSON.parse(clean);
            const scamPct = Math.min(100, Math.max(0, Number(p.scam_confidence_percent) || 100));
            let action = p.action ?? 'SKIP';
            if (scamPct >= 5 && action === 'BUY') {
                action = 'SKIP';
                logger_1.logger.info(`[GrokAgent] $${token.ticker} BUY→SKIP (scam ${scamPct}%)`);
            }
            return {
                action,
                confidencePercent: Math.min(100, Math.max(0, Number(p.confidence_percent) || 0)),
                isScam: Boolean(p.is_scam),
                scamConfidencePercent: scamPct,
                narrative: p.narrative ?? '',
                kolSpotted: Boolean(p.kol_spotted),
                kolNames: Array.isArray(p.kol_names) ? p.kol_names : [],
                sentiment: p.sentiment ?? 'dead',
                velocity: p.velocity ?? 'dead',
                redFlags: Array.isArray(p.red_flags) ? p.red_flags : [],
                crossPlatform: Boolean(p.cross_platform),
                vibeScore: Math.min(10, Math.max(0, Number(p.vibe_score) || 0)),
                oneLiner: p.one_liner ?? '',
                rawMentionCount: Number(p.raw_mention_count) || 0,
                dataFetched: ['x_search', 'dexscreener'],
                reasoning: p.reasoning ?? '',
            };
        }
        catch {
            logger_1.logger.warn(`[GrokAgent] Parse failed for $${token.ticker} — raw: ${raw.slice(0, 100)}`);
            return this.deadDecision();
        }
    }
    deadDecision() {
        return {
            action: 'SKIP',
            confidencePercent: 0,
            isScam: true,
            scamConfidencePercent: 100,
            narrative: 'API error',
            kolSpotted: false,
            kolNames: [],
            sentiment: 'dead',
            velocity: 'dead',
            redFlags: ['Grok API failed'],
            crossPlatform: false,
            vibeScore: 0,
            oneLiner: 'Skip — no data',
            rawMentionCount: 0,
            dataFetched: [],
            reasoning: 'API failure',
        };
    }
}
exports.GrokAgent = GrokAgent;
//# sourceMappingURL=grokAgent.js.map