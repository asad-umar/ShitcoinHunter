/**
 * ClaudeReflection — Daily Opus-powered reflection (items 1, 4 & 6)
 *
 * At the end of each day, Claude Opus:
 * - Reviews all trades made that day
 * - Identifies patterns in what worked and what didn't
 * - Recommends threshold adjustments
 * - Detects if the strategy is failing and suggests a mode change
 * - Saves the reflection to disk
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { TradeRecord, DailyReflection, MemoryState } from '../types';
import { config } from '../config';
import { logger } from '../logger';

export class ClaudeReflection {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async runDailyReflection(
    todayTrades: TradeRecord[],
    allTrades: TradeRecord[],
    currentState: {
      vibeThreshold: number;
      confidenceThreshold: number;
      strategyMode: MemoryState['strategyMode'];
      consecutiveLosses: number;
      totalPnlUsd: number;
    },
  ): Promise<DailyReflection | null> {
    const date = new Date().toISOString().slice(0, 10);

    if (todayTrades.length === 0) {
      logger.info('[Reflection] No trades today — skipping reflection');
      return null;
    }

    logger.info(`[Reflection] Running Claude Opus reflection for ${date} (${todayTrades.length} trades)...`);

    const pastReflections = this.loadPastReflections(date, 3);
    const prompt = this.buildReflectionPrompt(todayTrades, allTrades, currentState, date, pastReflections);

    try {
      const message = await this.client.messages.create({
        model: config.anthropic.opusModel,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
        system: `You are a quantitative trading strategist reviewing a Solana memecoin trading bot's performance. 
Be analytical, honest, and specific. Identify real patterns — do not give generic advice.
Your recommendations directly affect the bot's next-day behavior. Be precise with numbers.
Respond ONLY with valid JSON. No markdown, no preamble.`,
      });

      const raw = message.content[0].type === 'text' ? message.content[0].text : '';
      const reflection = this.parseReflection(raw, todayTrades, date);
      reflection.rawOpusResponse = raw;

      this.saveReflection(reflection, date);
      logger.info(`[Reflection] Complete — recommended mode: ${reflection.recommendedStrategyMode}, threshold delta: ${reflection.recommendedThresholdChange}`);

      return reflection;
    } catch (err: any) {
      logger.error('[Reflection] Opus call failed', { error: err.message });
      return null;
    }
  }

  private loadPastReflections(today: string, count: number): DailyReflection[] {
    const dir = config.memory.reflectionFilePath;
    if (!fs.existsSync(dir)) return [];

    try {
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.json') && f.replace('.json', '') < today)
        .sort()
        .reverse()
        .slice(0, count);

      return files.map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
        return JSON.parse(raw) as DailyReflection;
      });
    } catch (err: any) {
      logger.warn('[Reflection] Could not load past reflections', { error: err.message });
      return [];
    }
  }

  private buildReflectionPrompt(
    today: TradeRecord[],
    all: TradeRecord[],
    state: {
      vibeThreshold: number;
      confidenceThreshold: number;
      strategyMode: MemoryState['strategyMode'];
      consecutiveLosses: number;
      totalPnlUsd: number;
    },
    date: string,
    pastReflections: DailyReflection[] = [],
  ): string {
    const todayWins = today.filter((t) => t.pnlUsd > 0);
    const todayLosses = today.filter((t) => t.pnlUsd <= 0);
    const todayPnl = today.reduce((s, t) => s + t.pnlUsd, 0);

    const recent30 = all.slice(-30);
    const recent30WinRate = recent30.filter((t) => t.pnlUsd > 0).length / Math.max(1, recent30.length);

    const avgScoreWinners = todayWins.length > 0
      ? todayWins.reduce((s, t) => s + t.vibeScoreAtEntry, 0) / todayWins.length
      : 0;
    const avgScoreLosers = todayLosses.length > 0
      ? todayLosses.reduce((s, t) => s + t.vibeScoreAtEntry, 0) / todayLosses.length
      : 0;

    const pastSection = pastReflections.length > 0
      ? `PREVIOUS REFLECTIONS (most recent first — use these to track whether your recommendations are working and avoid contradicting yourself without reason):
${pastReflections.map((r) => `
--- ${r.date} ---
Assessment: ${r.strategyAssessment}
Patterns: ${r.patternInsights}
Recommended: threshold ${r.recommendedThresholdChange > 0 ? '+' : ''}${r.recommendedThresholdChange}, mode → ${r.recommendedStrategyMode}
Key learnings: ${r.keyLearnings.join(' | ')}
Tomorrow focus: ${r.tomorrowFocus}`).join('\n')}

`
      : '';

    return `${pastSection}Analyze the trading bot's performance for ${date}.

TODAY'S TRADES (${today.length} total):
${today.map((t) => `  $${t.ticker}: entry $${t.entryPriceUsd.toFixed(6)}, exit $${t.exitPriceUsd.toFixed(6)}, PnL ${t.pnlPercent > 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}% ($${t.pnlUsd.toFixed(2)})
    Vibe score: ${t.vibeScoreAtEntry}/10, Confidence: ${t.confidenceAtEntry}%
    Exit reason: ${t.exitReason}, KOL: ${t.kolSpotted ? 'yes' : 'no'}
    Narrative: "${t.narrative}"
    Red flags at entry: ${t.redFlagsAtEntry.join(', ') || 'none'}
    Data sources used: ${t.dataSourcesUsed.join(', ')}`).join('\n\n')}

TODAY SUMMARY:
  Wins: ${todayWins.length} | Losses: ${todayLosses.length}
  Total PnL: $${todayPnl.toFixed(2)}
  Avg vibe score (winners): ${avgScoreWinners.toFixed(1)}
  Avg vibe score (losers): ${avgScoreLosers.toFixed(1)}

CURRENT BOT STATE:
  Vibe threshold: ${state.vibeThreshold}/10
  Confidence threshold: ${state.confidenceThreshold}%
  Strategy mode: ${state.strategyMode}
  Consecutive losses: ${state.consecutiveLosses}
  All-time PnL: $${state.totalPnlUsd.toFixed(2)}
  30-day win rate: ${(recent30WinRate * 100).toFixed(1)}%

Analyze and respond with this JSON:
{
  "strategy_assessment": "2-3 sentence honest assessment of how the strategy is performing",
  "pattern_insights": "what patterns do you see in the winners vs losers — vibe score cutoffs, KOL presence, exit reasons, etc.",
  "recommended_threshold_change": integer from -2 to +2 (negative = lower threshold, positive = raise it),
  "recommended_strategy_mode": "normal" | "conservative" | "aggressive" | "paused",
  "key_learnings": ["up to 4 specific, actionable insights"],
  "tomorrow_focus": "one concrete thing the bot should prioritize tomorrow",
  "is_strategy_failing": true | false,
  "failure_reason": "if failing, why — otherwise null"
}`;
  }

  private parseReflection(raw: string, trades: TradeRecord[], date: string): DailyReflection {
    try {
      const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      const p = JSON.parse(clean);

      const wins = trades.filter((t) => t.pnlUsd > 0);
      const losses = trades.filter((t) => t.pnlUsd <= 0);

      return {
        date,
        totalTrades: trades.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        totalPnlUsd: trades.reduce((s, t) => s + t.pnlUsd, 0),
        winRate: wins.length / Math.max(1, trades.length),
        avgVibeScoreWinners: wins.length > 0 ? wins.reduce((s, t) => s + t.vibeScoreAtEntry, 0) / wins.length : 0,
        avgVibeScoreLosers: losses.length > 0 ? losses.reduce((s, t) => s + t.vibeScoreAtEntry, 0) / losses.length : 0,
        strategyAssessment: p.strategy_assessment ?? '',
        patternInsights: p.pattern_insights ?? '',
        recommendedThresholdChange: Math.min(2, Math.max(-2, parseInt(p.recommended_threshold_change) || 0)),
        recommendedStrategyMode: p.recommended_strategy_mode ?? 'normal',
        keyLearnings: Array.isArray(p.key_learnings) ? p.key_learnings : [],
        tomorrowFocus: p.tomorrow_focus ?? '',
        rawOpusResponse: raw,
      };
    } catch {
      return {
        date,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: trades.length,
        totalPnlUsd: 0,
        winRate: 0,
        avgVibeScoreWinners: 0,
        avgVibeScoreLosers: 0,
        strategyAssessment: 'Parse error — could not read Opus response',
        patternInsights: '',
        recommendedThresholdChange: 0,
        recommendedStrategyMode: 'normal',
        keyLearnings: [],
        tomorrowFocus: '',
        rawOpusResponse: raw,
      };
    }
  }

  private saveReflection(reflection: DailyReflection, date: string): void {
    try {
      const dir = config.memory.reflectionFilePath;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${date}.json`);
      fs.writeFileSync(filePath, JSON.stringify(reflection, null, 2));
      logger.info(`[Reflection] Saved to ${filePath}`);
    } catch (err: any) {
      logger.error('[Reflection] Save failed', { error: err.message });
    }
  }
}
