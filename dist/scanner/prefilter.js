"use strict";
/**
 * PreFilter — 3-stage zero-cost funnel before any Grok call
 *
 * Stage 0: Profanity filter    — reject tokens with offensive names/tickers
 * Stage 1: Hard numeric gates  — reject on bad on-chain metrics
 * Stage 2: Heuristic score     — local signal scoring, only ≥6 passes
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PreFilter = void 0;
const logger_1 = require("../logger");
// ── Thresholds ────────────────────────────────────────────────────────────────
const THRESHOLDS = {
    minLiquidityUsd: 2000,
    maxLiquidityUsd: 500000,
    minBuys1h: 25,
    maxAgeMinutes: 45,
    minMarketCapUsd: 5000,
    maxMarketCapUsd: 5000000,
    minVolume1h: 1000,
    heuristicPassScore: 6,
};
// ── Profanity list ────────────────────────────────────────────────────────────
// Whole-word and substring matches against name + ticker + description.
// Kept as plain strings (lowercased) so the list is easy to extend.
const PROFANITY = [
    // Slurs and hate speech
    'nigger', 'nigga', 'faggot', 'fag', 'chink', 'spic', 'kike',
    'tranny', 'retard', 'retarded', 'cunt', 'beaner', 'wetback',
    'gook', 'raghead', 'sandnigger', 'towelhead', 'cracker', 'honky',
    // Sexual / graphic
    'fuck', 'fucker', 'fucked', 'fucking', 'motherfucker', 'mf',
    'shit', 'bullshit', 'shitcoin', // shitcoin is often in descriptions — keep if you want
    'cock', 'dick', 'pussy', 'ass', 'asshole', 'bitch', 'whore',
    'slut', 'cum', 'jizz', 'piss', 'rape', 'rapist',
    'penis', 'vagina', 'anal', 'porn', 'xxx', 'nsfw',
    // Extreme / illegal
    'pedo', 'pedophile', 'cp', 'loli', 'genocide', 'hitler', 'nazi',
];
// Build a single regex for fast matching (word-boundary aware where possible)
const PROFANITY_REGEX = new RegExp(PROFANITY.map((w) => `\\b${w}\\b`).join('|'), 'i');
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
class PreFilter {
    evaluate(token, onChain) {
        const text = `${token.name} ${token.ticker} ${token.description}`;
        // ── Stage 0: Profanity ────────────────────────────
        const profanityMatch = PROFANITY_REGEX.exec(text);
        if (profanityMatch) {
            const word = profanityMatch[0].toLowerCase();
            logger_1.logger.debug(`[PreFilter] PROFANITY $${token.ticker}: matched "${word}"`);
            return {
                pass: false,
                stage: 'profanity',
                reason: `Profane word detected: "${word}"`,
            };
        }
        // ── Stage 1: Hard numeric gates ───────────────────
        const hardFail = this.hardFilter(onChain);
        if (hardFail) {
            logger_1.logger.debug(`[PreFilter] HARD FAIL $${token.ticker}: ${hardFail}`);
            return { pass: false, stage: 'hard_filter', reason: hardFail };
        }
        // ── Stage 2: Heuristic score ──────────────────────
        const score = this.heuristicScore(token, onChain, text);
        if (score < THRESHOLDS.heuristicPassScore) {
            logger_1.logger.debug(`[PreFilter] HEURISTIC FAIL $${token.ticker}: score ${score}/10`);
            return {
                pass: false,
                stage: 'heuristic',
                reason: `Score ${score}/10 — below threshold ${THRESHOLDS.heuristicPassScore}`,
                heuristicScore: score,
            };
        }
        logger_1.logger.info(`[PreFilter] PASS $${token.ticker}: heuristic ${score}/10 → Grok`);
        return { pass: true, stage: 'passed', reason: 'ok', heuristicScore: score };
    }
    // ── Stage 1 ───────────────────────────────────────────────────────────────────
    hardFilter(onChain) {
        if (onChain.liquidityUsd < THRESHOLDS.minLiquidityUsd)
            return `Liquidity $${onChain.liquidityUsd.toFixed(0)} < $${THRESHOLDS.minLiquidityUsd}`;
        if (onChain.liquidityUsd > THRESHOLDS.maxLiquidityUsd)
            return `Liquidity $${onChain.liquidityUsd.toFixed(0)} > $${THRESHOLDS.maxLiquidityUsd} (too large)`;
        if (onChain.ageMinutes > THRESHOLDS.maxAgeMinutes)
            return `Age ${onChain.ageMinutes.toFixed(0)}m > ${THRESHOLDS.maxAgeMinutes}m limit`;
        if (onChain.marketCapUsd < THRESHOLDS.minMarketCapUsd)
            return `MCap $${onChain.marketCapUsd.toFixed(0)} < $${THRESHOLDS.minMarketCapUsd}`;
        if (onChain.marketCapUsd > THRESHOLDS.maxMarketCapUsd)
            return `MCap $${onChain.marketCapUsd.toFixed(0)} > $${THRESHOLDS.maxMarketCapUsd}`;
        if (onChain.holderCount < THRESHOLDS.minBuys1h)
            return `Buys ${onChain.holderCount} < ${THRESHOLDS.minBuys1h} minimum`;
        if (onChain.volumeUsd24h < THRESHOLDS.minVolume1h)
            return `Volume $${onChain.volumeUsd24h.toFixed(0)} < $${THRESHOLDS.minVolume1h}`;
        return null;
    }
    // ── Stage 2 ───────────────────────────────────────────────────────────────────
    heuristicScore(token, onChain, text) {
        // Rug pattern = instant zero
        if (RUG_PATTERNS.some((p) => p.test(text))) {
            logger_1.logger.debug(`[PreFilter] Rug pattern in $${token.ticker}`);
            return 0;
        }
        let score = 0;
        if (onChain.liquidityUsd >= 10000)
            score += 2;
        else if (onChain.liquidityUsd >= 5000)
            score += 1;
        const buysPerMin = onChain.ageMinutes > 0 ? onChain.holderCount / onChain.ageMinutes : 0;
        if (buysPerMin >= 5)
            score += 2;
        else if (buysPerMin >= 2)
            score += 1;
        if (onChain.ageMinutes <= 5)
            score += 2;
        else if (onChain.ageMinutes <= 15)
            score += 1;
        const memeHits = MEME_SIGNALS.filter((p) => p.test(text)).length;
        if (memeHits >= 2)
            score += 2;
        else if (memeHits >= 1)
            score += 1;
        const volLiqRatio = onChain.volumeUsd24h / Math.max(1, onChain.liquidityUsd);
        if (volLiqRatio >= 3)
            score += 2;
        else if (volLiqRatio >= 1)
            score += 1;
        return Math.min(10, score);
    }
    getThresholds() { return THRESHOLDS; }
    getProfanityList() { return [...PROFANITY]; }
}
exports.PreFilter = PreFilter;
//# sourceMappingURL=prefilter.js.map