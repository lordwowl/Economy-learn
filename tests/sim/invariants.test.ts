// Инварианты модели (GDD 5.15, CLAUDE.md) на всех ботах-политиках и нескольких сценариях.
import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { sumBreakdown } from '../../src/sim/causes';
import type { WorldState } from '../../src/sim';
import { policies, policyNames } from '../../tools/policies';
import { runPolicy, totalMoney, type Run, type ScenarioPatch } from './helpers';

const TURNS = 24;
const EPS = 1e-6;
const data = getGameData();

const scenarios: Record<string, ScenarioPatch | undefined> = {
  baseline: undefined,
  jam: (sc) => {
    sc.routes.find((r) => r.id === 'centerSouth')!.lanes = 1;
  },
  smallFleet: (sc) => {
    sc.fleet.private = 2;
  },
  stockpile: (sc) => {
    sc.reserve.storages.push({ building: 'warehouse', province: 'south' }, { building: 'elevator', province: 'north' });
    sc.reserve.stock.push({ province: 'south', good: 'bread', quantity: 300 }, { province: 'north', good: 'grain', quantity: 800 });
  },
};

/** Все числа в состоянии конечны (NaN/Infinity — признак ошибки в формуле). */
function nonFinite(value: unknown, path = 'state'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nonFinite(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => nonFinite(v, `${path}.${k}`));
  return [];
}

function storageCapacity(state: WorldState, province: string): number {
  return state.reserve.storages
    .filter((s) => s.ready && s.province === province)
    .reduce((sum, s) => {
      const b = data.buildings.find((x) => x.id === s.building);
      return sum + (b?.kind === 'storage' ? b.storageCapacity : 0);
    }, 0);
}

function checkRun(r: Run): void {
  const start = totalMoney(r.states[0]!);
  r.states.forEach((s, t) => {
    const at = `ход ${t}`;
    expect(nonFinite(s), at).toEqual([]);
    expect(totalMoney(s), `${at}: деньги − долги`).toBeCloseTo(start, 4);
    expect(s.government.cash, at).toBeGreaterThanOrEqual(-EPS);
    expect(s.government.debt, at).toBeGreaterThanOrEqual(-EPS);
    expect(s.metrics.unemployment, at).toBeGreaterThanOrEqual(-EPS);
    expect(s.metrics.unemployment, at).toBeLessThanOrEqual(1 + EPS);
    for (const p of s.provinces) {
      expect(p.households.cash, `${at} ${p.id}`).toBeGreaterThanOrEqual(-EPS);
      expect(p.households.debt, `${at} ${p.id}`).toBeGreaterThanOrEqual(-EPS);
      const stock = Object.values(s.reserve.stock[p.id] ?? {}).reduce((a, b) => a + b, 0);
      for (const q of Object.values(s.reserve.stock[p.id] ?? {})) expect(q, `${at} резерв ${p.id}`).toBeGreaterThanOrEqual(-EPS);
      expect(stock, `${at} резерв ${p.id} ≤ складов`).toBeLessThanOrEqual(storageCapacity(s, p.id) + EPS);
    }
    for (const c of s.logistics.carriers) {
      expect(c.cash, `${at} ${c.id}`).toBeGreaterThanOrEqual(-EPS);
      expect(c.debt, `${at} ${c.id}`).toBeGreaterThanOrEqual(-EPS);
      expect(c.fuel, `${at} ${c.id}`).toBeGreaterThanOrEqual(-EPS);
    }
    for (const f of s.firms) {
      expect(f.cash, `${at} ${f.id}`).toBeGreaterThanOrEqual(-EPS);
      expect(f.debt, `${at} ${f.id}`).toBeGreaterThanOrEqual(-EPS);
      for (const [g, q] of Object.entries(f.inventory)) expect(q, `${at} ${f.id} ${g}`).toBeGreaterThanOrEqual(-EPS);
      if (t > 0) expect(f.lastRuns, `${at} ${f.id}: выпуск ≤ мощности`).toBeLessThanOrEqual(f.capacity + EPS);
      expect(sumBreakdown(f.breakdown), `${at} ${f.id}: Σ компонент`).toBeCloseTo(f.price, 9);
    }
    for (const [g, m] of Object.entries(s.market)) {
      expect(sumBreakdown(m.breakdown), `${at} ${g}`).toBeCloseTo(m.price, 9);
      for (const [p, pm] of Object.entries(m.provinces)) expect(sumBreakdown(pm.breakdown), `${at} ${g} ${p}`).toBeCloseTo(pm.price, 9);
    }
    for (const [id, route] of Object.entries(s.metrics.routes)) {
      for (const d of route.directions) expect(d.flow, `${at} ${id} → ${d.to}`).toBeLessThanOrEqual(route.capacity + EPS);
    }
  });
}

/** События журнала согласованы с метриками: Σ вкладов = delta, delta = изменение метрики. */
function checkCauses(r: Run): void {
  for (let t = 1; t < r.states.length; t++) {
    const prev = r.states[t - 1]!;
    const s = r.states[t]!;
    const scalar: Record<string, number> = {
      cpi: s.metrics.cpi - prev.metrics.cpi,
      ppi: s.metrics.ppi - prev.metrics.ppi,
      wage: s.wage - prev.wage,
      unemployment: s.metrics.unemployment - prev.metrics.unemployment,
      'budget.balance': s.metrics.budgetBalance,
    };
    for (const [g, m] of Object.entries(s.market)) {
      scalar[`price.${g}`] = m.price - prev.market[g]!.price;
      for (const [p, pm] of Object.entries(m.provinces)) scalar[`price.${g}.${p}`] = pm.price - prev.market[g]!.provinces[p]!.price;
    }
    for (const e of r.causes[t]!) {
      expect(e.causes.reduce((a, c) => a + c.value, 0), `ход ${t} ${e.metric}`).toBeCloseTo(e.delta, 9);
      const expected = scalar[e.metric];
      if (expected !== undefined) expect(e.delta, `ход ${t} ${e.metric}`).toBeCloseTo(expected, 9);
    }
  }
}

describe.each(Object.entries(scenarios))('сценарий %s', (_name, patch) => {
  describe.each(policyNames)('политика %s', (name) => {
    const r = runPolicy(TURNS, policies[name]!, data, patch);

    it('инварианты состояния', () => checkRun(r));
    it('журнал согласован с метриками', () => checkCauses(r));
  });
});

describe('детерминизм', () => {
  it('одинаковый сценарий, seed и политика → одинаковый результат', () => {
    const a = runPolicy(TURNS, policies.ceiling!, data, scenarios.jam);
    const b = runPolicy(TURNS, policies.ceiling!, data, scenarios.jam);
    expect(b.states.at(-1)).toEqual(a.states.at(-1));
    expect(b.causes).toEqual(a.causes);
  });
});
