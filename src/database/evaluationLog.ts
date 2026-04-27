import fs   from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface EvaluationRecord {
  id:           string;
  date:         string;        // YYYY-MM-DD
  evaluatedAt:  string;        // ISO
  mint:         string;
  ticker:       string;
  name:         string;
  // Metrics at evaluation time
  mcapUsd:      number;
  volUsd:       number;
  liqUsd:       number;
  holders:      number;
  ageMinutes:   number;
  // Grok decision
  grokAction:   string;        // BUY | SKIP | WATCHLIST
  vibeScore:    number;
  scamPct:      number;
  reasoning:    string;
  oneLiner:     string;
  // What the bot did after Grok's call
  botAction:    string;        // bought | skipped | watchlisted | blocked_scam | blocked_score
  // Outcome — filled in by retro
  outcome?: {
    checkedAt:      string;
    currentMcap:    number;
    multiplier:     number;    // currentMcap / mcapUsd at eval time
    classification: 'runner' | 'rug' | 'flat' | 'unknown';
  };
}

const DATA_DIR = 'data/evaluations';

function filePath(date: string): string {
  return path.join(DATA_DIR, `${date}.json`);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load(date: string): EvaluationRecord[] {
  const fp = filePath(date);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e: any) {
    logger.warn(`[EvalLog] Failed to load ${fp}: ${e.message}`);
  }
  return [];
}

function save(date: string, records: EvaluationRecord[]): void {
  ensureDir();
  fs.writeFileSync(filePath(date), JSON.stringify(records, null, 2));
}

export function appendEvaluation(record: Omit<EvaluationRecord, 'id' | 'date'>): void {
  const date    = todayStr();
  const records = load(date);
  records.push({
    ...record,
    id:   `${record.mint}-${Date.now()}`,
    date,
  });
  save(date, records);
}

export function loadEvaluations(date: string): EvaluationRecord[] {
  return load(date);
}

export function updateOutcomes(date: string, updates: Map<string, EvaluationRecord['outcome']>): void {
  const records = load(date);
  for (const rec of records) {
    const outcome = updates.get(rec.mint);
    if (outcome) rec.outcome = outcome;
  }
  save(date, records);
}
