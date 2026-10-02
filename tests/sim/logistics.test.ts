import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { sumBreakdown } from '../../src/sim/causes';
import type { Route } from '../../src/sim/state';
import { fuelPerUnit, pairKey, planShipments, shortestPaths, tariff } from '../../src/sim/systems/logistics';
import { run, totalMoney, type ScenarioPatch } from './helpers';

const { balance } = getGameData();
const cfg = balance.logistics;
const provinces = ['a', 'b', 'c'];
const routes: Route[] = [
  { id: 'ab', a: 'a', b: 'b', length: 3, lanes: 1 },
  { id: 'bc', a: 'b', b: 'c', length: 3, lanes: 1 },
  { id: 'ac', a: 'a', b: 'c', length: 10, lanes: 1 },
];

describe('кратчайшие пути', () => {
  it('идут через промежуточную провинцию, если так короче', () => {
    const p = shortestPaths(provinces, routes).get(pairKey('a', 'c'))!;
    expect(p.length).toBe(6);
    expect(p.edges).toEqual(['ab', 'bc']);
  });

  it('дорога без полос непроезжая', () => {
    const closed = routes.map((r) => (r.id === 'bc' ? { ...r, lanes: 0 } : r));
    expect(shortestPaths(provinces, closed).get(pairKey('a', 'c'))!.edges).toEqual(['ac']);
    expect(shortestPaths(provinces, [{ ...routes[0]!, lanes: 0 }]).has(pairKey('a', 'b'))).toBe(false);
  });
});

describe('тариф (GDD 5.2)', () => {
  const path = shortestPaths(provinces, routes).get(pairKey('a', 'c'))!;

  it('топливо 0.02 × длина + труд 0.01 на ребро, плюс наценка перевозчика', () => {
    const expected = (cfg.fuelPerUnitLength * 6 * 2 + cfg.laborPerUnit * 2 * 10) * (1 + cfg.markup);
    expect(tariff(path, 2, 10, cfg)).toBeCloseTo(expected, 12);
  });

  it('дорожает топливо → дорожает доставка', () => {
    expect(tariff(path, 3, 10, cfg)).toBeGreaterThan(tariff(path, 2, 10, cfg));
  });
});

describe('планирование перевозок', () => {
  const paths = shortestPaths(provinces, routes);
  const unlimited = { capacityLeft: { ab: 1e9, bc: 1e9, ac: 1e9 }, fuel: 1e9, labor: 1e9 };

  it('не больше остатков продавцов', () => {
    const s = planShipments([{ good: 'g', deficits: { c: 100 }, stocks: { a: 30 } }], paths, unlimited, cfg);
    expect(s.reduce((x, y) => x + y.quantity, 0)).toBeCloseTo(30, 9);
  });

  it('не больше пропускной способности дороги, все товары урезаются одинаково', () => {
    const s = planShipments(
      [
        { good: 'g', deficits: { b: 100 }, stocks: { a: 100 } },
        { good: 'h', deficits: { b: 300 }, stocks: { a: 300 } },
      ],
      paths,
      { ...unlimited, capacityLeft: { ab: 200, bc: 1e9, ac: 1e9 } },
      cfg,
    );
    const g = s.find((x) => x.good === 'g')!;
    const h = s.find((x) => x.good === 'h')!;
    expect(g.quantity + h.quantity).toBeCloseTo(200, 9);
    expect(g.quantity / g.requested).toBeCloseTo(h.quantity / h.requested, 12);
    expect(g.bottlenecks).toEqual(['ab']);
    expect(g.blockedByRoad + h.blockedByRoad).toBeCloseTo(200, 9);
  });

  it('без топлива перевозчик никуда не едет', () => {
    const s = planShipments([{ good: 'g', deficits: { c: 50 }, stocks: { a: 50 } }], paths, { ...unlimited, fuel: 0 }, cfg);
    expect(s.every((x) => x.quantity === 0)).toBe(true);
  });

  it('топлива на перевозку уходит 0.02 × длина на единицу', () => {
    expect(fuelPerUnit(paths.get(pairKey('a', 'c'))!, cfg)).toBeCloseTo(0.02 * 6, 12);
  });
});

describe('логистика в ходе симуляции', () => {
  const TURNS = 24;
  const passive = run(TURNS);
  const lanes = (n: number): ScenarioPatch => (sc) => {
    sc.routes.find((r) => r.id === 'centerSouth')!.lanes = n;
  };
  const jammed = run(TURNS, () => [], undefined, lanes(2));
  const BUILD_TURN = 3;
  const built = run(TURNS, (t) => (t === BUILD_TURN ? [{ type: 'addRoadLane', route: 'centerSouth' }] : []), undefined, lanes(2));

  it('поток по дороге ≤ её пропускной способности', () => {
    for (const r of [passive, jammed, built]) {
      for (const s of r.states.slice(1)) {
        for (const m of Object.values(s.metrics.routes)) expect(m.flow).toBeLessThanOrEqual(m.capacity + 1e-6);
      }
    }
  });

  it('деньги сохраняются вместе с кассой перевозчика, топливо перевозчика ≥ 0', () => {
    for (const r of [passive, jammed, built]) {
      const start = totalMoney(r.states[0]!);
      for (const s of r.states) {
        expect(totalMoney(s)).toBeCloseTo(start, 6);
        expect(s.logistics.fuel).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('Σ компонент цены = цена в каждой провинции', () => {
    for (const s of passive.states) {
      for (const m of Object.values(s.market)) {
        for (const pm of Object.values(m.provinces)) expect(sumBreakdown(pm.breakdown)).toBeCloseTo(pm.price, 9);
      }
    }
  });

  it('привозное дороже: топливо на севере (возят из центра) дороже, чем в центре, и в цене есть логистика', () => {
    const fuel = passive.states[6]!.market.fuel!;
    expect(fuel.provinces.north!.price).toBeGreaterThan(fuel.provinces.center!.price);
    expect(fuel.provinces.north!.breakdown.logistics ?? 0).toBeGreaterThan(0);
  });

  it('узкое место: при двух полосах дорога забита, на юге дефицит топлива', () => {
    const t = 3;
    expect(jammed.states[t]!.metrics.routes.centerSouth!.blocked).toBeGreaterThan(0);
    expect(jammed.states[t]!.metrics.provinceShortage.south!.fuel).toBeGreaterThan(0.1);
    expect(passive.states[t]!.metrics.provinceShortage.south!.fuel).toBeLessThan(0.05);
  });

  it('стройка полосы: готова через 3 хода, после этого дефицит на юге ниже, чем без стройки', () => {
    const lane = getGameData().buildings.find((b) => b.kind === 'route')!;
    const ready = BUILD_TURN + lane.buildTurns;
    expect(built.states[ready - 1]!.routes.find((r) => r.id === 'centerSouth')!.lanes).toBe(2);
    expect(built.states[ready]!.routes.find((r) => r.id === 'centerSouth')!.lanes).toBe(3);
    const later = ready + 4;
    expect(built.states[later]!.metrics.provinceShortage.south!.fuel).toBeLessThan(
      jammed.states[later]!.metrics.provinceShortage.south!.fuel!,
    );
  });

  it('неизвестная дорога в действии — ошибка', () => {
    expect(() => run(1, () => [{ type: 'addRoadLane', route: 'nowhere' }])).toThrow(/nowhere/);
  });
});
