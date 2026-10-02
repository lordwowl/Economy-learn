import { describe, expect, it } from 'vitest';
import { getGameData, getScenario } from '../../src/data';
import { createInitialState, Rng, step, type Action, type WorldState } from '../../src/sim';
import { stateFirmCost } from '../../src/sim/step';
import { SEED, totalMoney } from './helpers';

const data = getGameData();

function play(scenario: string, turns: number, actionsAt: (t: number) => Action[] = () => []): WorldState[] {
  const rng = new Rng(SEED);
  const states = [createInitialState(data, getScenario(scenario))];
  for (let t = 1; t <= turns; t++) states.push(step(states[t - 1]!, actionsAt(t), rng, data).state);
  return states;
}

describe('новые фирмы (GDD 5.8)', () => {
  it('частная фирма после стройки рассчитывает на долю заказов и начинает производить', () => {
    // Сценарий «Цепочка»: мельниц не хватает — рынок достраивает их сам.
    const states = play('chain', 16);
    const entrant = states.at(-1)!.firms.find((f) => f.building === 'mill' && f.id.includes('-t'));
    expect(entrant, 'частная мельница так и не открылась').toBeDefined();
    const ready = states.findIndex((s) => s.firms.some((f) => f.id === entrant!.id && !f.underConstruction));
    const produced = states.slice(ready + 1, ready + 3).some((s) => (s.firms.find((f) => f.id === entrant!.id)?.lastRuns ?? 0) > 0);
    expect(produced).toBe(true);
  });
});

describe('госпредприятия (GDD 3)', () => {
  const mill = data.buildings.find((b) => b.id === 'mill')!;
  const refinery = data.buildings.find((b) => b.id === 'refinery')!;
  const states = play('baseline', mill.buildTurns + 3, (t) => (t === 1 ? [{ type: 'buildStateFirm', building: 'mill', province: 'south' }] : []));

  it('частное по природе здание государству дороже, НПЗ — по своей цене', () => {
    if (mill.kind !== 'producer' || refinery.kind !== 'producer') throw new Error('ожидались производственные здания');
    expect(stateFirmCost(mill, data.balance)).toBeCloseTo(mill.cost * data.balance.government.stateFirmCostMultiplier, 9);
    expect(stateFirmCost(refinery, data.balance)).toBe(refinery.cost);
    expect(states[1]!.government.spending.construction).toBeCloseTo(stateFirmCost(mill as never, data.balance), 6);
  });

  it('строится buildTurns ходов, принадлежит государству и производит', () => {
    const firm = (s: WorldState) => s.firms.find((f) => f.id === 'mill-south-s1')!;
    expect(firm(states[1]!)).toMatchObject({ owner: 'state', underConstruction: true, capacity: 0 });
    expect(firm(states[mill.buildTurns + 1]!).underConstruction).toBe(false);
    expect(firm(states.at(-1)!).lastRuns).toBeGreaterThan(0);
  });

  it('деньги − долги сохраняются', () => {
    const start = totalMoney(states[0]!);
    for (const s of states) expect(totalMoney(s)).toBeCloseTo(start, 4);
  });
});

describe('сценарии уровней', () => {
  it('наследуют базовый сценарий: карта и дороги те же, переопределённые поля — свои', () => {
    const base = getScenario('baseline');
    const chain = getScenario('chain');
    expect(chain.map).toEqual(base.map);
    expect(chain.routes).toEqual(base.routes);
    expect(chain.firms.filter((f) => f.building === 'mill').reduce((s, f) => s + f.count, 0)).toBeLessThan(
      base.firms.filter((f) => f.building === 'mill').reduce((s, f) => s + f.count, 0),
    );
  });

  it('потолок на старте: доля стартовой цены производителей, срез уже в ценах фирм', () => {
    const s = createInitialState(data, getScenario('ceiling'));
    const free = createInitialState(data, getScenario('baseline'));
    const share = getScenario('ceiling').priceCeilings!.bread!;
    expect(s.government.priceCeilings.bread).toBeCloseTo(share * free.market.bread!.producerPrice, 9);
    for (const f of s.firms.filter((x) => x.building === 'bakery')) {
      expect(f.breakdown.priceCeiling!).toBeLessThan(0);
      expect(f.price).toBeCloseTo(s.government.priceCeilings.bread!, 9);
    }
  });

  it('«Перегрев»: ставка на старте ниже равновесной, ожидания выше цели', () => {
    const scenario = getScenario('overheating');
    const s = createInitialState(data, scenario);
    expect(s.keyRate).toBe(scenario.startKeyRate);
    expect(s.demandRate).toBe(scenario.startKeyRate);
    expect(s.expectations.expected).toBeCloseTo(Math.pow(1 + scenario.expectedInflation!, 1 / 12) - 1, 12);
  });
});
