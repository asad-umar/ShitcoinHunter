import axios  from 'axios';
import { logger }  from '../logger';
import { config }  from '../config';
import {
  loadEvaluations,
  updateOutcomes,
  EvaluationRecord,
} from '../database/evaluationLog';

interface RetroReport {
  date:            string;
  totalEvaluated:  number;
  missedRunners:   EvaluationRecord[];   // Grok skipped, token pumped 2x+
  correctSkips:    EvaluationRecord[];   // Grok skipped, token rugged/flat
  boughtRunners:   EvaluationRecord[];   // bot bought, token pumped
  boughtRugs:      EvaluationRecord[];   // bot bought, token rugged
  patterns:        string;               // Grok analysis text
  suggestions:     FilterSuggestions;
  telegramText:    string;
}

interface FilterSuggestions {
  minVolumeUsd?:      number;
  minMarketCapUsd?:   number;
  minLiquidityUsd?:   number;
  minBuys?:           number;
  vibeThresholdDelta: number;
  reasoning:          string;
}

// 2x = runner, <0.4x = rug
const RUNNER_MULTIPLIER = 2.0;
const RUG_MULTIPLIER    = 0.4;

async function fetchCurrentMcap(mint: string): Promise<number | null> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 5_000 },
    );
    const pairs: any[] = res.data?.pairs ?? [];
    const sol = pairs.find((p: any) => p.chainId === 'solana');
    return sol?.marketCap ?? null;
  } catch {
    return null;
  }
}

async function fetchOutcomes(records: EvaluationRecord[]): Promise<Map<string, EvaluationRecord['outcome']>> {
  const map = new Map<string, EvaluationRecord['outcome']>();
  const now = new Date().toISOString();
  const CONCURRENCY = 10;

  // Process in parallel batches to avoid sequential 5s-per-token delays
  for (let i = 0; i < records.length; i += CONCURRENCY) {
    const batch = records.slice(i, i + CONCURRENCY).filter(r => r.mcapUsd > 0);
    await Promise.all(batch.map(async (rec) => {
      const currentMcap = await fetchCurrentMcap(rec.mint);
      if (currentMcap === null) {
        map.set(rec.mint, { checkedAt: now, currentMcap: 0, multiplier: 0, classification: 'unknown' });
        return;
      }
      const multiplier     = currentMcap / rec.mcapUsd;
      const classification = multiplier >= RUNNER_MULTIPLIER ? 'runner'
        : multiplier <= RUG_MULTIPLIER ? 'rug'
        : multiplier > 1.0 ? 'gained'
        : 'flat';

      map.set(rec.mint, { checkedAt: now, currentMcap, multiplier, classification });
    }));
  }

  logger.info(`[Retro] Fetched outcomes for ${map.size}/${records.length} tokens`);
  return map;
}

async function analyzeWithGrok(
  missed:  EvaluationRecord[],
  rugged:  EvaluationRecord[],
  bought:  EvaluationRecord[],
): Promise<FilterSuggestions> {
  const fmt = (r: EvaluationRecord) =>
    `$${r.ticker} | mcap:$${r.mcapUsd.toFixed(0)} vol:$${r.volUsd.toFixed(0)} ` +
    `liq:$${r.liqUsd.toFixed(0)} holders:${r.holders} age:${r.ageMinutes.toFixed(0)}m ` +
    `vibe:${r.vibeScore} scam:${r.scamPct}% | ` +
    `outcome: ${r.outcome?.multiplier.toFixed(2) ?? '?'}x (${r.outcome?.classification ?? '?'}) | ` +
    `reasoning: "${r.reasoning}"`;

  const prompt = [
    `You are analyzing the performance of a Solana memecoin trading bot's filter criteria for ${new Date().toISOString().slice(0, 10)}.`,
    ``,
    `MISSED RUNNERS (bot skipped, token went ${RUNNER_MULTIPLIER}x+):`,
    missed.length > 0 ? missed.map(fmt).join('\n') : 'none',
    ``,
    `CORRECT SKIPS (bot skipped, token rugged or went flat):`,
    rugged.length > 0 ? rugged.slice(0, 10).map(fmt).join('\n') : 'none',
    ``,
    `BOUGHT TOKENS AND OUTCOMES:`,
    bought.length > 0 ? bought.map(fmt).join('\n') : 'none',
    ``,
    `Analyze the patterns. What metrics at evaluation time distinguished missed runners from correct skips?`,
    `Which filter thresholds were too strict (causing missed runners) or too lenient (causing bad buys)?`,
    ``,
    `Return JSON only:`,
    `{`,
    `  "patterns": "<2-3 sentence summary of key patterns>",`,
    `  "minVolumeUsd": <number or null if no change>,`,
    `  "minMarketCapUsd": <number or null if no change>,`,
    `  "minLiquidityUsd": <number or null if no change>,`,
    `  "minBuys": <number or null if no change>,`,
    `  "vibeThresholdDelta": <-1, 0, or 1>,`,
    `  "reasoning": "<30 words>"`,
    `}`,
  ].join('\n');

  try {
    const res = await axios.post(
      `${config.grok.baseUrl}/chat/completions`,
      {
        model:       config.grok.model,
        messages:    [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens:  400,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization:  `Bearer ${config.grok.apiKey}`,
        },
        timeout: 30_000,
      },
    );

    const raw   = res.data.choices?.[0]?.message?.content ?? '{}';
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      minVolumeUsd:      parsed.minVolumeUsd      ?? undefined,
      minMarketCapUsd:   parsed.minMarketCapUsd   ?? undefined,
      minLiquidityUsd:   parsed.minLiquidityUsd   ?? undefined,
      minBuys:           parsed.minBuys           ?? undefined,
      vibeThresholdDelta: Number(parsed.vibeThresholdDelta) || 0,
      reasoning:         parsed.reasoning ?? '',
    };
  } catch (e: any) {
    logger.warn(`[Retro] Grok analysis failed: ${e.message}`);
    return { vibeThresholdDelta: 0, reasoning: 'Analysis unavailable' };
  }
}

function buildTelegramReport(
  date:     string,
  records:  EvaluationRecord[],
  outcomes: Map<string, EvaluationRecord['outcome']>,
  missed:   EvaluationRecord[],
  correct:  EvaluationRecord[],
  bought:   EvaluationRecord[],
  sug:      FilterSuggestions,
): string {
  const runners = bought.filter(r => r.outcome?.classification === 'runner');
  const rugs    = bought.filter(r => r.outcome?.classification === 'rug');

  const lines: string[] = [
    `📊 <b>Daily Retro — ${date}</b>`,
    `Evaluated by Grok: ${records.length} tokens`,
    ``,
  ];

  if (missed.length > 0) {
    lines.push(`🚀 <b>Missed Runners</b> (skipped, then pumped ${RUNNER_MULTIPLIER}x+):`);
    const sortedMissed = [...missed].sort((a, b) => (b.outcome?.currentMcap ?? 0) - (a.outcome?.currentMcap ?? 0));
    for (const r of sortedMissed) {
      const multiplier = r.outcome?.multiplier.toFixed(1) ?? '?';
      const mcapThen   = `$${r.mcapUsd.toFixed(0)}`;
      const mcapNow    = r.outcome?.currentMcap ? `$${r.outcome.currentMcap.toFixed(0)}` : '?';
      lines.push(`  $${r.ticker} <code>${r.mint}</code> → ${multiplier}x | identified: ${mcapThen} mcap → now: ${mcapNow} mcap`);
      lines.push(`  vibe:${r.vibeScore} scam:${r.scamPct}% | <i>"${r.oneLiner}"</i>`);
    }
    lines.push('');
  }

  const gainedOnly = records.filter(r => r.grokAction !== 'BUY' && r.outcome?.classification === 'gained');
  if (gainedOnly.length > 0) {
    lines.push(`📈 <b>Missed Gains</b> (skipped, went up but under ${RUNNER_MULTIPLIER}x):`);
    const sortedGained = [...gainedOnly].sort((a, b) => (b.outcome?.currentMcap ?? 0) - (a.outcome?.currentMcap ?? 0));
    for (const r of sortedGained) {
      const multiplier = r.outcome?.multiplier.toFixed(2) ?? '?';
      const mcapThen   = `$${r.mcapUsd.toFixed(0)}`;
      const mcapNow    = r.outcome?.currentMcap ? `$${r.outcome.currentMcap.toFixed(0)}` : '?';
      lines.push(`  $${r.ticker} <code>${r.mint}</code> → ${multiplier}x | identified: ${mcapThen} → now: ${mcapNow}`);
    }
    lines.push('');
  }

  if (runners.length > 0) {
    lines.push(`✅ <b>Bought Runners:</b>`);
    for (const r of [...runners].sort((a, b) => (b.outcome?.currentMcap ?? 0) - (a.outcome?.currentMcap ?? 0))) {
      lines.push(`  $${r.ticker} <code>${r.mint}</code> → ${r.outcome?.multiplier.toFixed(1)}x`);
    }
    lines.push('');
  }

  if (rugs.length > 0) {
    lines.push(`💀 <b>Bought Rugs:</b>`);
    for (const r of [...rugs].sort((a, b) => (b.outcome?.currentMcap ?? 0) - (a.outcome?.currentMcap ?? 0))) {
      lines.push(`  $${r.ticker} <code>${r.mint}</code> → ${r.outcome?.multiplier.toFixed(2)}x`);
    }
    lines.push('');
  }

  lines.push(`✓ <b>Correct Skips:</b> ${correct.length}`);
  lines.push('');

  lines.push(`🔧 <b>Filter Suggestions:</b>`);
  lines.push(sug.reasoning);
  if (sug.minVolumeUsd !== undefined)    lines.push(`  minVolume → $${sug.minVolumeUsd}`);
  if (sug.minMarketCapUsd !== undefined) lines.push(`  minMcap → $${sug.minMarketCapUsd}`);
  if (sug.minLiquidityUsd !== undefined) lines.push(`  minLiquidity → $${sug.minLiquidityUsd}`);
  if (sug.minBuys !== undefined)         lines.push(`  minBuys → ${sug.minBuys}`);
  if (sug.vibeThresholdDelta !== 0)      lines.push(`  vibeThreshold ${sug.vibeThresholdDelta > 0 ? '+' : ''}${sug.vibeThresholdDelta}`);
  if (sug.minVolumeUsd === undefined && sug.minMarketCapUsd === undefined &&
      sug.minLiquidityUsd === undefined && sug.minBuys === undefined &&
      sug.vibeThresholdDelta === 0) {
    lines.push('  No changes recommended');
  }

  return lines.join('\n');
}

export async function runDailyRetro(date: string): Promise<{
  telegramText: string;
  vibeThresholdDelta: number;
}> {
  logger.info(`[Retro] Running daily retrospective for ${date}`);
  const records = loadEvaluations(date);

  if (records.length === 0) {
    return { telegramText: `📊 <b>Daily Retro — ${date}</b>\nNo tokens evaluated today.`, vibeThresholdDelta: 0 };
  }

  // Fetch current market caps
  const outcomes = await fetchOutcomes(records);
  updateOutcomes(date, outcomes);

  // Attach outcomes to records for analysis
  for (const rec of records) {
    if (outcomes.has(rec.mint)) rec.outcome = outcomes.get(rec.mint);
  }

  const missed  = records.filter(r => r.grokAction !== 'BUY' && r.outcome?.classification === 'runner');
  const correct = records.filter(r => r.grokAction !== 'BUY' && r.outcome?.classification !== 'runner');
  const bought  = records.filter(r => r.botAction === 'bought');

  const suggestions = await analyzeWithGrok(missed, correct, bought);

  const telegramText = buildTelegramReport(date, records, outcomes, missed, correct, bought, suggestions);

  logger.info(`[Retro] Complete — ${missed.length} missed runners, ${correct.length} correct skips, ${bought.length} bought`);

  return { telegramText, vibeThresholdDelta: suggestions.vibeThresholdDelta };
}
