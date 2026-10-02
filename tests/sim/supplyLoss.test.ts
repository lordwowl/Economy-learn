import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { run } from './helpers';

// Недопроизводство (GDD 6): сколько желаемого выпуска не произвели и почему; Σ вкладов = потерянный выпуск.

const data = getGameData();
const SHOCK_TURN = 3;
const grainOut = data.recipes.find((r) => r.id === 'grain')!.output.amount;
const harvest = data.shocks.find((s) => s.id === 'harvestFailure')!;
const harvestCut = harvest.effects[0]!;
const loss = (causes: ReturnType<typeof run>['causes'], turn: number, good: string) => causes[turn]!.find((c) => c.metric === `supplyLoss.${good}`);

describe('недопроизводство в журнале', () => {
  const shocked = run(10, (t) => (t === SHOCK_TURN ? [{ type: 'shock', shock: 'harvestFailure' }] : []));

  it('шок урезает выпуск ферм: причина «шок», не больше срезанной мощности', () => {
    const states = shocked.states;
    for (let t = SHOCK_TURN; t < SHOCK_TURN + harvest.turns; t++) {
      const event = loss(shocked.causes, t, 'grain')!;
      const shock = event.causes.find((c) => c.ref === 'shock.harvestFailure')!;
      expect(shock.value).toBeGreaterThan(0);
      const farms = states[t - 1]!.firms.filter((f) => f.building === 'farm');
      const cut = farms.reduce((s, f) => s + f.capacity, 0) * (1 - harvestCut.multiplier) * grainOut;
      expect(shock.value).toBeLessThanOrEqual(cut + 1e-9);
    }
    for (const t of [1, 2, SHOCK_TURN + harvest.turns + 1]) {
      expect(loss(shocked.causes, t, 'grain')?.causes.some((c) => c.ref.startsWith('shock.')) ?? false).toBe(false);
    }
  });

  it('нехватка зерна передаётся дальше: мельницам не хватает входа «зерно»', () => {
    const flour = shocked.causes.slice(SHOCK_TURN).flatMap((c) => c.filter((e) => e.metric === 'supplyLoss.flour'));
    expect(flour.some((e) => (e.causes.find((c) => c.ref === 'input.grain')?.value ?? 0) > 0)).toBe(true);
  });

  it('вклады неотрицательны и в сумме дают потерянный выпуск', () => {
    for (const events of shocked.causes) {
      for (const e of events.filter((x) => x.metric.startsWith('supplyLoss.'))) {
        expect(e.delta).toBeGreaterThan(0);
        expect(e.causes.reduce((s, c) => s + c.value, 0)).toBeCloseTo(e.delta, 9);
        for (const c of e.causes) expect(c.value).toBeGreaterThan(0);
      }
    }
  });

  it('потолок ниже себестоимости: недопроизводство хлеба из-за убытков или потолка', () => {
    const startPrice = run(0).states[0]!.market.bread!.price;
    const r = run(8, (t) => (t === 1 ? [{ type: 'setPriceCeiling', good: 'bread', price: 0.6 * startPrice }] : []));
    const refs = new Set(r.causes.slice(2).flatMap((c) => c.filter((e) => e.metric === 'supplyLoss.bread').flatMap((e) => e.causes.map((x) => x.ref))));
    expect(refs.has('unprofitable')).toBe(true);
  });
});
