// Баланс уровней (CLAUDE.md, M11): уровень проходим, у разных стратегий разные исходы.
// Golden: уровень + seed + бот → исход, звёзды, статусы целей и итоговые показатели.
// Намеренно изменили баланс → `UPDATE_GOLDEN=1 npm test` и запись в PROGRESS.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLevels } from '../../src/data';
import { policyNames } from '../../tools/policies';
import { parseArgs, simulate } from '../../tools/sim-runner';

const DIR = join(import.meta.dirname, 'golden');
const update = process.env.UPDATE_GOLDEN === '1';
const RELATIVE_TOLERANCE = 1e-6;

/** Задуманное решение уровня: бот, который должен получить все три звезды. */
const SOLUTION: Record<string, string> = { chain: 'builder', harvest: 'reserve', ceiling: 'lift', overheating: 'neutral' };

interface Outcome {
  outcome: string;
  stars: number;
  defeatTurn: number | null;
  goals: Record<string, string>;
  cpi: number;
  unemployment: number;
  maxUnemployment: number;
  maxBreadShortage: number;
}

function outcome(level: string, policy: string): Outcome {
  const { rows, level: status } = simulate({ ...parseArgs(['--level', level]), policy });
  const last = rows.at(-1)!;
  return {
    outcome: status!.outcome,
    stars: status!.stars,
    defeatTurn: status!.defeat?.turn ?? null,
    goals: Object.fromEntries(status!.goals.map((g) => [g.id, g.state])),
    cpi: last.cpi,
    unemployment: last.unemployment,
    maxUnemployment: Math.max(...rows.map((r) => r.unemployment)),
    maxBreadShortage: Math.max(...rows.map((r) => r.maxShortage.bread ?? 0)),
  };
}

describe.each(getLevels().map((l) => [l.id, l] as const))('уровень %s', (id, level) => {
  const results = Object.fromEntries(policyNames.map((p) => [p, outcome(id, p)]));

  it('задуманное решение — три звезды, бездействие — меньше', () => {
    const solution = SOLUTION[id];
    expect(solution, `нет задуманного решения для уровня ${id}`).toBeDefined();
    expect(results[solution!]!.stars).toBe(3);
    expect(results.passive!.stars).toBeLessThan(3);
    expect(new Set(Object.values(results).map((r) => `${r.outcome}:${r.stars}`)).size).toBeGreaterThan(1);
  });

  it('итоги ботов совпадают с эталоном', () => {
    const file = join(DIR, `level-${id}.json`);
    if (!existsSync(file) && process.env.CI) throw new Error(`нет эталона ${file}: создайте его локально (UPDATE_GOLDEN=1 npm test)`);
    if (update || !existsSync(file)) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, JSON.stringify({ level: id, seed: level.seed, turns: level.turns, results }, null, 1) + '\n');
      return;
    }
    const golden = JSON.parse(readFileSync(file, 'utf8')) as { results: Record<string, Outcome> };
    const diffs: string[] = [];
    for (const [policy, actual] of Object.entries(results)) {
      const expected = golden.results[policy];
      if (!expected) {
        diffs.push(`${policy}: нет в эталоне`);
        continue;
      }
      for (const key of Object.keys(actual) as (keyof Outcome)[]) {
        const a = actual[key];
        const e = expected[key];
        const same =
          typeof a === 'number' && typeof e === 'number'
            ? Math.abs(a - e) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(e))
            : JSON.stringify(a) === JSON.stringify(e);
        if (!same) diffs.push(`${policy} ${key}: ${JSON.stringify(a)} ≠ ${JSON.stringify(e)}`);
      }
    }
    expect(diffs.slice(0, 10), 'разница с эталоном; если изменение намеренное — UPDATE_GOLDEN=1 npm test').toEqual([]);
  });
});
