"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GrokAnalyzer = void 0;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../logger");
class GrokAnalyzer {
    constructor() {
        this.headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config_1.config.grok.apiKey}`,
        };
    }
    async analyzeToken(token, onChain) {
        const prompt = this.buildPrompt(token, onChain);
        try {
            const response = await axios_1.default.post(`${config_1.config.grok.baseUrl}/chat/completions`, {
                model: config_1.config.grok.model,
                messages: [
                    {
                        role: 'system',
                        content: `You are a crypto degen analyst specialising in Solana memecoins. 
You have real-time access to X (Twitter). Be fast, blunt, and accurate.
Your job is to assess if a new shitcoin has genuine social momentum RIGHT NOW.
ALWAYS respond with valid JSON only. No markdown, no preamble, no explanation outside the JSON.`,
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.3, // Lower = more consistent JSON output
                max_tokens: 600,
            }, {
                headers: this.headers,
                timeout: 20000,
            });
            const raw = response.data.choices?.[0]?.message?.content ?? '';
            return this.parseGrokResponse(raw, token);
        }
        catch (err) {
            logger_1.logger.error('Grok API error', { error: err.message, ticker: token.ticker });
            return this.defaultDeadResult(token);
        }
    }
    buildPrompt(token, onChain) {
        return `Search X RIGHT NOW for mentions of $${token.ticker} and Solana contract address ${token.mintAddress}.

Token details:
- Name: ${token.name}
- Ticker: $${token.ticker}
- Description: ${token.description.slice(0, 200)}
- Age: ${Math.round(onChain.ageMinutes)} minutes old
- Liquidity: $${onChain.liquidityUsd.toFixed(0)}
- Market cap: $${onChain.marketCapUsd.toFixed(0)}

Search X for:
1. Direct mentions of $${token.ticker} or the contract address
2. Any accounts with 10k+ followers posting about it (KOLs)
3. Sentiment in replies — are people excited or calling rug?
4. Is this spreading to other platforms (Telegram groups, Reddit mentioned in tweets)?
5. Is there a clear narrative/meme angle?

Return ONLY this JSON (no other text):
{
  "narrative": "One sentence describing the meme/story angle, or 'none' if no clear angle",
  "kol_spotted": true or false,
  "kol_names": ["@handle (~Xk followers)" — list up to 3],
  "sentiment": "moon" | "hype" | "neutral" | "sus" | "rug" | "dead",
  "velocity": "exploding" | "rising" | "flat" | "dead",
  "red_flags": ["list any warnings found — rug alerts, copied contract, dev selling, etc"],
  "cross_platform": true or false,
  "vibe_score": integer 0-10,
  "one_liner": "Your gut call in one plain sentence — would you personally ape in?",
  "raw_mention_count": estimated number of X posts in last 2 hours
}

Scoring guide:
9-10: KOL 100k+ posted, strong narrative, exploding velocity, zero red flags
7-8: Multiple KOLs or one big one, clear meme, rising fast
5-6: Some chatter, decent narrative, worth watching
3-4: Weak story, flat velocity, minimal buzz  
0-2: Dead on X, or red flags present (potential rug)`;
    }
    parseGrokResponse(raw, token) {
        try {
            // Strip any accidental markdown fences
            const clean = raw
                .replace(/```json\s*/gi, '')
                .replace(/```\s*/g, '')
                .trim();
            const parsed = JSON.parse(clean);
            return {
                narrative: parsed.narrative ?? 'No narrative found',
                kolSpotted: Boolean(parsed.kol_spotted),
                kolNames: Array.isArray(parsed.kol_names) ? parsed.kol_names : [],
                sentiment: parsed.sentiment ?? 'dead',
                velocity: parsed.velocity ?? 'dead',
                redFlags: Array.isArray(parsed.red_flags) ? parsed.red_flags : [],
                crossPlatform: Boolean(parsed.cross_platform),
                vibeScore: Math.min(10, Math.max(0, parseInt(parsed.vibe_score) || 0)),
                oneLiner: parsed.one_liner ?? 'No signal found',
                rawMentionCount: parseInt(parsed.raw_mention_count) || 0,
            };
        }
        catch (err) {
            logger_1.logger.warn(`Failed to parse Grok response for ${token.ticker}`, { raw: raw.slice(0, 200) });
            return this.defaultDeadResult(token);
        }
    }
    defaultDeadResult(token) {
        return {
            narrative: 'API error — no data',
            kolSpotted: false,
            kolNames: [],
            sentiment: 'dead',
            velocity: 'dead',
            redFlags: ['Grok API failed — treat as unknown'],
            crossPlatform: false,
            vibeScore: 0,
            oneLiner: 'Could not retrieve social data',
            rawMentionCount: 0,
        };
    }
}
exports.GrokAnalyzer = GrokAnalyzer;
//# sourceMappingURL=analyzer.js.map