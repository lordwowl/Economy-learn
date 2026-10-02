import { describe, expect, it } from 'vitest';
import scenarioRaw from '../../data/scenarios/baseline.json';
import { getGameData, loadScenario } from '../../src/data';
import { contextFromState } from '../../src/game/explain';
import { pendingItems } from '../../src/game/pending';
import { addDecision, createSession, currentState, endTurn, fastForward, previousState, removeDecision } from '../../src/game/session';
import { monthSummary } from '../../src/game/summary';
import { run } from '../sim/helpers';

const data = getGameData();
const scenario = loadScenario(scenarioRaw, data);
const consumerGoods = Object.keys(data.balance.demand.goods);

describe('сессия', () => {
  it('решения по одному рычагу заменяют друг друга, стройки складываются, отмена работает', () => {
    let s = createSession(data, scenario, 42);
    s = addDecision(s, { type: 'setKeyRate', rate: 0.08 });
    s = addDecision(s, { type: 'setKeyRate', rate: 0.1 });
    s = addDecision(s, { type: 'buildStateFleet' });
    s = addDecision(s, { type: 'buildStateFleet' });
    expect(s.decisions).toEqual([{ type: 'setKeyRate', rate: 0.1 }, { type: 'buildStateFleet' }, { type: 'buildStateFleet' }]);
    s = removeDecision(s, 1);
    expect(s.decisions).toHaveLength(2);
  });

  it('ход применяет решения, очищает их и пишет историю; совпадает с прямым прогоном', () => {
    let s = createSession(data, scenario, 42);
    s = addDecision(s, { type: 'setKeyRate', rate: 0.1 });
    s = endTurn(s, data);
    expect(s.decisions).toEqual([]);
    expect(s.history).toHaveLength(2);
    expect(currentState(s).keyRate).toBe(0.1);
    s = fastForward(s, data, 3);
    expect(currentState(s).turn).toBe(4);
    const direct = run(4, (t) => (t === 1 ? [{ type: 'setKeyRate', rate: 0.1 }] : []));
    expect(currentState(s)).toEqual(direct.states[4]);
    expect(previousState(s)).toEqual(direct.states[3]);
  });

  it('сессия сериализуется в JSON без потерь', () => {
    const s = fastForward(createSession(data, scenario, 7), data, 2);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe('«в пути»', () => {
  it('ставка, субсидия и стройки видны с числом месяцев до эффекта', () => {
    let s = createSession(data, scenario, 42);
    s = addDecision(s, { type: 'setKeyRate', rate: 0.12 });
    s = addDecision(s, { type: 'setSubsidy', good: 'bread', perUnit: 1 });
    s = addDecision(s, { type: 'addRoadLane', route: 'northCenter' });
    s = addDecision(s, { type: 'buildStorage', building: 'warehouse', province: 'south' });
    s = endTurn(s, data);
    const items = pendingItems(currentState(s));
    const kinds = items.map((i) => i.kind);
    for (const k of ['demandRate', 'creditRate', 'subsidy', 'roadLane', 'storage']) expect(kinds).toContain(k);
    const demand = items.find((i) => i.kind === 'demandRate')!;
    expect(demand.amount).toBeCloseTo(0.06, 9);
    expect(demand.turnsLeft).toBe(data.balance.lags.keyRateToDemand.full);
    const lane = data.buildings.find((b) => b.kind === 'route')!;
    expect(items.find((i) => i.kind === 'roadLane')!.turnsLeft).toBe(lane.buildTurns);
  });
});

describe('сводка месяца', () => {
  it('от 3 до 5 пунктов, самые заметные первыми, с причинами из журнала', () => {
    const r = run(6, (t) => (t === 2 ? [{ type: 'shock', shock: 'harvestFailure' }] : []));
    const ctx = contextFromState(r.states[4]!);
    const items = monthSummary(r.states[3]!, r.states[4]!, r.causes[4]!, ctx, consumerGoods);
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.importance).toBeGreaterThanOrEqual(items[i]!.importance);
    expect(items.some((i) => i.causes.length > 0)).toBe(true);
  });

  it('копеечный дефицит в сводку не попадает', () => {
    const r = run(2);
    const items = monthSummary(r.states[0]!, r.states[1]!, r.causes[1]!, contextFromState(r.states[1]!), consumerGoods);
    expect(items.some((i) => i.kind === 'deficit')).toBe(false);
  });

  it('при остром дефиците в провинции он попадает в сводку', () => {
    const r = run(4, () => [], undefined, (sc) => {
      sc.routes.find((x) => x.id === 'centerSouth')!.lanes = 1;
    });
    const items = monthSummary(r.states[2]!, r.states[3]!, r.causes[3]!, contextFromState(r.states[3]!), consumerGoods);
    expect(items.some((i) => i.kind === 'deficit' && i.target === 'south')).toBe(true);
  });
});
