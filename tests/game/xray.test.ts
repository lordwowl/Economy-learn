import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { CHART_METRICS, series } from '../../src/game/charts';
import { expandChain, groupOf, xray } from '../../src/game/xray';
import { run } from '../sim/helpers';

const fuel = getGameData().balance.logistics.fuelGood;
const r = run(6, (t) => (t === 2 ? [{ type: 'setSubsidy', good: 'flour', perUnit: 50 }] : []));
const s = r.states[6]!;

describe('рентген товара', () => {
  it('Σ частей, раскрытых по цепочке, = цена (страна и провинция)', () => {
    for (const good of Object.keys(s.market)) {
      const total = expandChain(s, good, undefined, fuel).reduce((a, p) => a + p.value, 0);
      expect(total, good).toBeCloseTo(s.market[good]!.price, 9);
      const south = expandChain(s, good, 'south', fuel).reduce((a, p) => a + p.value, 0);
      expect(south, good).toBeCloseTo(s.market[good]!.provinces.south!.price, 9);
    }
  });

  it('хлеб раскрывается до зерна; топливо не раскрывается — сквозная строка', () => {
    const parts = expandChain(s, 'bread', undefined, fuel);
    const links = new Set(parts.map((p) => p.link));
    expect([...links].sort()).toEqual(['bread', 'flour', 'grain']);
    expect(parts.some((p) => p.ref === `input.${fuel}`)).toBe(true);
    expect(parts.every((p) => !p.ref.startsWith('input.') || p.ref === `input.${fuel}`)).toBe(true);
  });

  it('группы и звенья в сумме дают цену; звенья — от начала цепочки, топливо в конце', () => {
    const x = xray(s, r.states[5], 'bread', undefined, fuel);
    expect(x.groups.reduce((a, g) => a + g.value, 0)).toBeCloseTo(x.price, 9);
    expect(x.links.reduce((a, l) => a + l.value, 0)).toBeCloseTo(x.price, 9);
    expect(x.links.map((l) => l.link)).toEqual(['grain', 'flour', 'bread', fuel]);
    expect(x.groups.find((g) => g.group === 'policy')!.value).toBeLessThan(0);
    expect(x.prevPrice).toBe(r.states[5]!.market.bread!.price);
  });

  it('группы компонент', () => {
    expect(groupOf('input.flour', fuel)).toBe('inputs');
    expect(groupOf(`input.${fuel}`, fuel)).toBe('fuel');
    expect(groupOf('tax.sales', fuel)).toBe('taxes');
    expect(groupOf('priceCeiling', fuel)).toBe('policy');
  });
});

describe('ряды графиков', () => {
  it('по одному значению на ход, доли — в процентах', () => {
    for (const metric of CHART_METRICS) {
      const { turns, values } = series(r.states, metric);
      expect(turns).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(values.every(Number.isFinite)).toBe(true);
    }
    expect(series(r.states, 'unemployment').values[3]).toBeCloseTo(r.states[3]!.metrics.unemployment * 100, 12);
  });
});
