import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { sumBreakdown } from '../../src/sim/causes';
import type { CarrierId, Route, WorldState } from '../../src/sim/state';
import { fuelPerUnit, legKey, pairKey, planShipments, shortestPaths, tariff } from '../../src/sim/systems/logistics';
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
    expect(p.edges).toEqual([legKey('ab', 'b'), legKey('bc', 'c')]);
  });

  it('дорога без полос непроезжая', () => {
    const closed = routes.map((r) => (r.id === 'bc' ? { ...r, lanes: 0 } : r));
    expect(shortestPaths(provinces, closed).get(pairKey('a', 'c'))!.edges).toEqual([legKey('ac', 'c')]);
    expect(shortestPaths(provinces, [{ ...routes[0]!, lanes: 0 }]).has(pairKey('a', 'b'))).toBe(false);
  });
});

describe('тариф (GDD 5.2)', () => {
  const path = shortestPaths(provinces, routes).get(pairKey('a', 'c'))!;

  it('топливо 0.02 × длина + труд 0.01 на ребро, плюс наценка перевозчика', () => {
    const expected = (cfg.fuelPerUnitLength * 6 * 2 + cfg.laborPerUnit * 2 * 10) * (1 + cfg.markup);
    expect(tariff(path, 2, 10, cfg, cfg.markup)).toBeCloseTo(expected, 12);
    expect(tariff(path, 2, 10, cfg, 0)).toBeCloseTo(expected / (1 + cfg.markup), 12);
  });

  it('дорожает топливо → дорожает доставка', () => {
    expect(tariff(path, 3, 10, cfg, cfg.markup)).toBeGreaterThan(tariff(path, 2, 10, cfg, cfg.markup));
  });
});

describe('планирование перевозок', () => {
  const paths = shortestPaths(provinces, routes);
  const legs = Object.fromEntries(routes.flatMap((r) => [legKey(r.id, r.a), legKey(r.id, r.b)]).map((k) => [k, 1e9]));
  const unlimited = { capacityLeft: legs, work: 1e9, labor: 1e9 };

  it('не больше остатков продавцов', () => {
    const s = planShipments([{ good: 'g', deficits: { c: 100 }, stocks: { a: 30 } }], paths, unlimited, cfg);
    expect(s.reduce((x, y) => x + y.quantity, 0)).toBeCloseTo(30, 9);
  });

  it('встречное направление не занимает пропускную способность', () => {
    const s = planShipments(
      [
        { good: 'g', deficits: { b: 200 }, stocks: { a: 200 } },
        { good: 'h', deficits: { a: 200 }, stocks: { b: 200 } },
      ],
      paths,
      { ...unlimited, capacityLeft: { ...legs, [legKey('ab', 'b')]: 200, [legKey('ab', 'a')]: 200 } },
      cfg,
    );
    for (const x of s) expect(x.quantity).toBeCloseTo(200, 9);
  });

  it('не больше пропускной способности дороги, все товары урезаются одинаково', () => {
    const s = planShipments(
      [
        { good: 'g', deficits: { b: 100 }, stocks: { a: 100 } },
        { good: 'h', deficits: { b: 300 }, stocks: { a: 300 } },
      ],
      paths,
      { ...unlimited, capacityLeft: { ...legs, [legKey('ab', 'b')]: 200 } },
      cfg,
    );
    const g = s.find((x) => x.good === 'g')!;
    const h = s.find((x) => x.good === 'h')!;
    expect(g.quantity + h.quantity).toBeCloseTo(200, 9);
    expect(g.quantity / g.requested).toBeCloseTo(h.quantity / h.requested, 12);
    expect(g.bottlenecks).toEqual([legKey('ab', 'b')]);
    expect(g.blockedByRoad + h.blockedByRoad).toBeCloseTo(200, 9);
  });

  it('без парка (или топлива) перевозчики никуда не едут', () => {
    const s = planShipments([{ good: 'g', deficits: { c: 50 }, stocks: { a: 50 } }], paths, { ...unlimited, work: 0 }, cfg);
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
  const jammed = run(TURNS, () => [], undefined, lanes(1));
  const BUILD_TURN = 3;
  const built = run(TURNS, (t) => (t === BUILD_TURN ? [{ type: 'addRoadLane', route: 'centerSouth' }] : []), undefined, lanes(1));

  it('поток по дороге ≤ её пропускной способности', () => {
    for (const r of [passive, jammed, built]) {
      for (const s of r.states.slice(1)) {
        for (const m of Object.values(s.metrics.routes)) {
          for (const d of m.directions) expect(d.flow).toBeLessThanOrEqual(m.capacity + 1e-6);
        }
      }
    }
  });

  it('деньги сохраняются вместе с кассами перевозчиков, их топливо ≥ 0', () => {
    for (const r of [passive, jammed, built]) {
      const start = totalMoney(r.states[0]!);
      for (const s of r.states) {
        expect(totalMoney(s)).toBeCloseTo(start, 6);
        for (const c of s.logistics.carriers) expect(c.fuel).toBeGreaterThanOrEqual(0);
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

  it('узкое место: при одной полосе дорога на юг забита, на юге дефицит топлива', () => {
    const t = 3;
    const toSouth = jammed.states[t]!.metrics.routes.centerSouth!.directions.find((d) => d.to === 'south')!;
    expect(toSouth.blocked).toBeGreaterThan(0);
    expect(jammed.states[t]!.metrics.provinceShortage.south!.fuel).toBeGreaterThan(0.1);
    expect(passive.states[t]!.metrics.provinceShortage.south!.fuel).toBeLessThan(0.05);
  });

  it('стройка полосы: готова через 3 хода, после этого дефицит на юге ниже, чем без стройки', () => {
    const lane = getGameData().buildings.find((b) => b.kind === 'route')!;
    const ready = BUILD_TURN + lane.buildTurns;
    expect(built.states[ready - 1]!.routes.find((r) => r.id === 'centerSouth')!.lanes).toBe(1);
    expect(built.states[ready]!.routes.find((r) => r.id === 'centerSouth')!.lanes).toBe(2);
    const later = ready + 4;
    expect(built.states[later]!.metrics.provinceShortage.south!.fuel).toBeLessThan(
      jammed.states[later]!.metrics.provinceShortage.south!.fuel!,
    );
  });

  it('неизвестная дорога в действии — ошибка', () => {
    expect(() => run(1, () => [{ type: 'addRoadLane', route: 'nowhere' }])).toThrow(/nowhere/);
  });
});

describe('парки перевозчиков (GDD 5.17)', () => {
  const data = getGameData();
  const fleet = data.buildings.find((b) => b.kind === 'fleet');
  if (fleet?.kind !== 'fleet') throw new Error('нет автопарка в данных');
  const carrier = (s: WorldState, id: CarrierId) => s.logistics.carriers.find((c) => c.id === id)!;
  const passiveRun = run(12);
  const small: ScenarioPatch = (sc) => {
    sc.fleet.private = 2;
  };
  const jam = run(12, () => [], undefined, small);
  const withState = run(12, (t) => (t === 1 ? Array.from({ length: 3 }, () => ({ type: 'buildStateFleet' as const })) : []), undefined, small);

  it('«auto»: стартовая загрузка частного парка не выше порога расширения', () => {
    const c = carrier(passiveRun.states[0]!, 'private');
    expect(c.lastWork / (c.fleet * fleet.workCapacity)).toBeLessThanOrEqual(data.balance.credit.entryMinUtilization);
  });

  it('маленький парк — узкое место: на юге дефицит топлива; частный перевозчик расширяется в кредит', () => {
    expect(jam.states[2]!.metrics.provinceShortage.south!.fuel!).toBeGreaterThan(0.1);
    const later = carrier(jam.states[8]!, 'private');
    expect(later.fleet).toBeGreaterThan(2);
    expect(Math.max(...jam.states.map((s) => carrier(s, 'private').debt))).toBeGreaterThan(0);
  });

  it('госпарк: стоит денег бюджета, готов через buildTurns, возит без наценки и снимает дефицит', () => {
    expect(withState.states[1]!.government.spending.construction).toBeCloseTo(3 * fleet.cost, 9);
    const ready = 1 + fleet.buildTurns;
    expect(carrier(withState.states[ready - 1]!, 'state').fleet).toBe(0);
    expect(carrier(withState.states[ready]!, 'state').fleet).toBe(3);
    expect(carrier(withState.states[ready + 1]!, 'state').lastWork).toBeGreaterThan(0);
    expect(carrier(withState.states[ready]!, 'state').markup).toBe(0);
    const t = ready + 1;
    expect(withState.states[t]!.metrics.provinceShortage.south!.fuel!).toBeLessThan(jam.states[t]!.metrics.provinceShortage.south!.fuel!);
  });

  it('деньги − долги сохраняются', () => {
    for (const r of [jam, withState]) {
      const start = totalMoney(r.states[0]!);
      for (const s of r.states) expect(totalMoney(s)).toBeCloseTo(start, 6);
    }
  });
});
