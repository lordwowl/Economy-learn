import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { sumBreakdown } from '../../src/sim/causes';
import { lossOutputFactor } from '../../src/sim/systems/production';
import { withCeiling, withoutCeiling } from '../../src/sim/systems/pricing';
import { run, totalMoney } from './helpers';

const { balance } = getGameData();

describe('потолок в разложении цены', () => {
  const own = { wage: 4, markup: 2, 'tax.sales': 1 };

  it('срез — отрицательная компонента priceCeiling, Σ = потолок', () => {
    const capped = withCeiling(own, 5);
    expect(capped.priceCeiling).toBe(-2);
    expect(sumBreakdown(capped)).toBe(5);
    expect(withoutCeiling(capped)).toEqual(own);
  });

  it('потолок выше цены ничего не меняет', () => {
    expect(withCeiling(own, 10)).toEqual(own);
    expect(withCeiling(own, undefined)).toEqual(own);
  });
});

describe('убыток режет выпуск', () => {
  it('выручка ≥ себестоимости — без изменений; ниже — пропорционально', () => {
    expect(lossOutputFactor(10, 8, balance.firms)).toBe(1);
    expect(lossOutputFactor(9, 10, balance.firms)).toBeCloseTo(1 - balance.firms.lossOutputCut * 0.1, 12);
    expect(lossOutputFactor(1, 10, balance.firms)).toBe(0);
  });
});

describe('потолок цен и чёрный рынок (GDD 5.6)', () => {
  const TURNS = 12;
  const CEILING_TURN = 2;
  const passive = run(TURNS);
  const startPrice = passive.states[CEILING_TURN - 1]!.market.bread!.price;
  const low = startPrice * 0.7;
  const r = run(TURNS, (t) => (t === CEILING_TURN ? [{ type: 'setPriceCeiling', good: 'bread', price: low }] : []));

  it('действует сразу: цены пекарен ≤ потолка, Σ компонент = цена', () => {
    for (const s of r.states.slice(CEILING_TURN)) {
      for (const f of s.firms.filter((x) => x.building === 'bakery')) {
        expect(f.price).toBeLessThanOrEqual(low + 1e-9);
        expect(sumBreakdown(f.breakdown)).toBeCloseTo(f.price, 9);
      }
    }
  });

  it('потолок ниже себестоимости → выпуск хлеба падает', () => {
    const t = CEILING_TURN + 1;
    expect(r.states[t]!.metrics.output.bread!).toBeLessThan(0.8 * passive.states[t]!.metrics.output.bread!);
  });

  it('через 1–3 хода — дефицит, затем чёрный рынок дороже потолка', () => {
    const shortageTurn = r.states.findIndex((s, t) => t > CEILING_TURN && s.metrics.shortage.bread! > 0.1);
    expect(shortageTurn).toBeGreaterThan(CEILING_TURN);
    expect(shortageTurn).toBeLessThanOrEqual(CEILING_TURN + 3);
    const black = r.states.slice(shortageTurn).map((s) => s.metrics.blackMarket.bread).find((b) => b && b.quantity > 0);
    expect(black).toBeDefined();
    expect(black!.price).toBeGreaterThan(low);
  });

  it('деньги − долги сохраняются', () => {
    const start = totalMoney(r.states[0]!);
    for (const s of r.states) expect(totalMoney(s)).toBeCloseTo(start, 6);
  });

  it('снятие потолка возвращает собственную цену фирмы', () => {
    const lifted = run(6, (t) =>
      t === 2 ? [{ type: 'setPriceCeiling', good: 'bread', price: low }] : t === 4 ? [{ type: 'setPriceCeiling', good: 'bread', price: null }] : [],
    );
    for (const f of lifted.states[4]!.firms) expect(f.breakdown.priceCeiling).toBeUndefined();
    expect(lifted.states[4]!.government.priceCeilings.bread).toBeUndefined();
  });
});
