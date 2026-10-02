// Golden-тесты (CLAUDE.md): сценарий + seed + бот → метрики по ходам совпадают с эталоном в допуске.
// Намеренно изменили баланс или формулы → `UPDATE_GOLDEN=1 npm test`, проверить разницу в git diff
// и записать причину в PROGRESS.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorldState } from '../../src/sim';
import { policies, policyNames } from '../../tools/policies';
import { runPolicy, SEED } from './helpers';

const TURNS = 24;
const RELATIVE_TOLERANCE = 1e-6;
const DIR = join(import.meta.dirname, 'golden');
const update = process.env.UPDATE_GOLDEN === '1';

/** Метрики, которые фиксирует эталон. */
function snapshot(s: WorldState): Record<string, number> {
  const m = s.metrics;
  const row: Record<string, number> = {
    cpi: m.cpi,
    ppi: m.ppi,
    unemployment: m.unemployment,
    wage: s.wage,
    gdp: m.gdp,
    budgetBalance: m.budgetBalance,
    governmentDebt: s.government.debt,
    householdSpending: m.householdSpending,
    firms: s.firms.length,
  };
  for (const [g, market] of Object.entries(s.market)) row[`price.${g}`] = market.price;
  for (const [g, q] of Object.entries(m.output)) row[`output.${g}`] = q;
  for (const [g, q] of Object.entries(m.shortage)) row[`shortage.${g}`] = q;
  return row;
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(expected));
}

describe.each(policyNames)('golden: baseline, seed %s', (name) => {
  const file = join(DIR, `baseline-${name}.json`);
  const rows = runPolicy(TURNS, policies[name]!).states.map(snapshot);

  it(`${name}: метрики по ходам совпадают с эталоном`, () => {
    if (!existsSync(file) && process.env.CI) throw new Error(`нет эталона ${file}: создайте его локально (UPDATE_GOLDEN=1 npm test)`);
    if (update || !existsSync(file)) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ scenario: 'baseline', seed: SEED, policy: name, turns: TURNS, rows }, null, 1) + '\n');
      return;
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as { rows: Record<string, number>[] };
    const diffs: string[] = [];
    rows.forEach((row, t) => {
      const expected = golden.rows[t];
      if (!expected) return diffs.push(`ход ${t}: нет в эталоне`);
      for (const key of new Set([...Object.keys(row), ...Object.keys(expected)])) {
        const a = row[key];
        const e = expected[key];
        if (a === undefined || e === undefined || !close(a, e)) diffs.push(`ход ${t} ${key}: ${a} ≠ ${e}`);
      }
    });
    expect(diffs.slice(0, 10), 'разница с эталоном; если изменение намеренное — UPDATE_GOLDEN=1 npm test').toEqual([]);
  });
});
