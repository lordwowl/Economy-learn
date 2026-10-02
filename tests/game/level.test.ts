import { describe, expect, it } from 'vitest';
import { getGameData, getLevels, getScenario, type Balance, type Level } from '../../src/data';
import { advanceLevel, evaluateLevel, findDefeat, isAllowed, levelEvents, startLevel } from '../../src/game/level';
import { addDecision, currentState, type Session } from '../../src/game/session';
import type { Action, WorldState } from '../../src/sim';

const data = getGameData();
const harvest = getLevels().find((l) => l.id === 'harvest')!;
const ceilingLevel = getLevels().find((l) => l.id === 'ceiling')!;
const SHOCK_TURN = harvest.events[0]!.turn;

/** Играет уровень до конца: decide(state) — решения игрока перед каждым ходом. */
function play(level: Level, decide: (state: WorldState) => Action[] = () => []): Session {
  let s = startLevel(data, level, getScenario(level.scenario));
  while (evaluateLevel(level, s.history, data.balance).outcome === 'playing') {
    for (const action of decide(currentState(s))) s = addDecision(s, action);
    s = advanceLevel(s, data, level, 1);
  }
  return s;
}

const status = (level: Level, s: Session) => evaluateLevel(level, s.history, data.balance);
const withGoals = (goals: Level['goals'], turns = harvest.turns): Level => ({ ...harvest, turns, goals });
const goal = (condition: Level['goals'][number]['condition'], star: 1 | 2 | 3 = 1) => ({ id: 'g', star, condition });

describe('контроллер уровня (GDD 4, 9)', () => {
  const passive = play(harvest);
  /** Игрок вводит потолок на хлеб на первом ходу (для целей «без потолка»). */
  const ceiling = play(harvest, (s) => (s.turn === 1 ? [{ type: 'setPriceCeiling', good: 'bread', price: Math.round(s.market.bread!.price * 0.85) }] : []));
  /** Уровень «Потолок» без вмешательства: унаследованный потолок ниже себестоимости ведёт к голоду. */
  const famine = play(ceilingLevel);

  it('шоки уровня срабатывают в своём ходу и записываются как события, а не решения игрока', () => {
    expect(levelEvents(harvest, SHOCK_TURN)).toEqual([{ type: 'shock', shock: 'harvestFailure' }]);
    expect(levelEvents(harvest, SHOCK_TURN + 1)).toEqual([]);
    expect(passive.history[SHOCK_TURN]!.events).toEqual([{ type: 'shock', shock: 'harvestFailure' }]);
    expect(passive.history[SHOCK_TURN]!.state.activeShocks.map((s) => s.id)).toContain('harvestFailure');
    expect(passive.history.every((h) => h.actions.length === 0)).toBe(true);
  });

  it('уровень заканчивается в срок: дальше ходы не идут', () => {
    expect(passive.history).toHaveLength(harvest.turns + 1);
    expect(advanceLevel(passive, data, harvest, 3).history).toHaveLength(harvest.turns + 1);
    const st = status(harvest, passive);
    expect(st.outcome).toBe('completed');
    // Без резерва дефицит хлеба выше порога первой звезды — звёзд нет, хотя уровень закончен.
    expect(st.goals.find((g) => g.id === 'noHunger')?.state).toBe('failed');
    expect(st.stars).toBe(0);
  });

  it('звезда N — только если получены все младшие', () => {
    const level = withGoals([
      goal({ kind: 'metric', metric: 'cpi', op: '>=', value: 1000, when: 'end' }, 1),
      { ...goal({ kind: 'noDecision', decision: 'setTax' }, 2), id: 'b' },
      { ...goal({ kind: 'noDecision', decision: 'setTax' }, 3), id: 'c' },
    ]);
    expect(status(level, passive).stars).toBe(0);
  });

  it('катастрофа: голод при потолке ниже себестоимости — проигрыш, игра останавливается', () => {
    const st = status(ceilingLevel, famine);
    expect(st.outcome).toBe('defeated');
    expect(st.defeat).toMatchObject({ reason: 'famine' });
    expect(famine.history).toHaveLength(st.defeat!.turn + 1);
    expect(st.stars).toBe(0);
    expect(st.goals.every((g) => g.state === 'failed')).toBe(true);
    const c = data.balance.catastrophe;
    const where = st.defeat as { province: string; turn: number };
    for (let t = where.turn - c.famineTurns + 1; t <= where.turn; t++) {
      expect(famine.history[t]!.state.metrics.provinceShortage[where.province]![c.famineGood]).toBeGreaterThanOrEqual(c.famineShortage);
    }
  });

  it('катастрофы: дефолт и потеря доверия — по порогам из balance.json', () => {
    const states = passive.history.map((h) => h.state);
    const withCatastrophe = (patch: Partial<Balance['catastrophe']>): Balance => ({ ...data.balance, catastrophe: { ...data.balance.catastrophe, ...patch } });
    expect(findDefeat(states, data.balance)).toBeUndefined();
    const firstDebt = states.find((s) => s.turn > 0 && s.government.debt > 0)!.turn;
    expect(findDefeat(states, withCatastrophe({ defaultDebtToAnnualGdp: 1e-9 }))).toEqual({ reason: 'default', turn: firstDebt });
    expect(findDefeat(states, withCatastrophe({ minTrust: 0.9 }))).toEqual({ reason: 'trust', turn: 1 });
  });

  it('end: пока уровень идёт — «в процессе», в конце — по последнему значению', () => {
    const level = withGoals([goal({ kind: 'metric', metric: 'cpi', op: '<=', value: 200, when: 'end' })]);
    const mid = { ...passive, history: passive.history.slice(0, 5) };
    expect(status(level, mid).goals[0]).toMatchObject({ state: 'pending' });
    expect(status(level, passive).goals[0]).toMatchObject({ state: 'met', value: currentState(passive).metrics.cpi });
  });

  it('always: проваливается сразу при нарушении, иначе выполняется в конце', () => {
    const level = withGoals([goal({ kind: 'metric', metric: 'unemployment', op: '<=', value: 0.1, when: 'always' })]);
    const firstBad = passive.history.findIndex((h) => h.state.turn > 0 && h.state.metrics.unemployment > 0.1);
    expect(firstBad).toBeGreaterThan(1);
    expect(status(level, { ...passive, history: passive.history.slice(0, firstBad) }).goals[0]!.state).toBe('pending');
    expect(status(level, { ...passive, history: passive.history.slice(0, firstBad + 1) }).goals[0]!.state).toBe('failed');
    const from = withGoals([goal({ kind: 'metric', metric: 'unemployment', op: '<=', value: 0.3, when: 'always', from: 2 })]);
    expect(status(from, passive).goals[0]!.state).toBe('met');
  });

  it('streak: выполнено, как только набралось N ходов подряд; провалено, когда не успеть', () => {
    const ok = withGoals([goal({ kind: 'metric', metric: 'cpi', op: '>=', value: 0, when: 'streak', turns: 3 })]);
    expect(status(ok, { ...passive, history: passive.history.slice(0, 3) }).goals[0]).toMatchObject({ state: 'pending', streak: 2 });
    expect(status(ok, { ...passive, history: passive.history.slice(0, 4) }).goals[0]!.state).toBe('met');
    const never = withGoals([goal({ kind: 'metric', metric: 'cpi', op: '>=', value: 1000, when: 'streak', turns: 3 })]);
    const late = passive.history.slice(0, harvest.turns - 1);
    expect(status(never, { ...passive, history: late }).goals[0]!.state).toBe('failed');
    expect(status(never, { ...passive, history: passive.history.slice(0, 3) }).goals[0]!.state).toBe('pending');
  });

  it('noDecision: проваливается при первом таком решении; снять потолок — не «ввести потолок»', () => {
    const level = withGoals([goal({ kind: 'noDecision', decision: 'setPriceCeiling' })]);
    expect(status(level, passive).goals[0]!.state).toBe('met');
    expect(status(level, { ...ceiling, history: ceiling.history.slice(0, 2) }).goals[0]!.state).toBe('pending');
    expect(status(level, { ...ceiling, history: ceiling.history.slice(0, 3) }).goals[0]!.state).toBe('failed');
    const removed = play(withGoals([goal({ kind: 'noDecision', decision: 'setPriceCeiling' })], 3), (s) =>
      s.turn === 0 ? [{ type: 'setPriceCeiling', good: 'bread', price: null }] : [],
    );
    expect(status(level, removed).goals[0]!.state).not.toBe('failed');
  });

  it('показатели целей: доли, дефицит в худшей провинции, долг к ВВП', () => {
    const level = withGoals([
      goal({ kind: 'metric', metric: 'maxShortage.bread', op: '<=', value: 1, when: 'end' }),
      { ...goal({ kind: 'metric', metric: 'inflationYoY', op: '<=', value: 1, when: 'end' }), id: 'b' },
      { ...goal({ kind: 'metric', metric: 'debtToGdp', op: '<=', value: 1, when: 'end' }), id: 'c' },
    ]);
    const mid = { ...ceiling, history: ceiling.history.slice(0, 9) };
    const [shortage, inflation, debt] = status(level, mid).goals.map((g) => g.value!);
    const s = mid.history.at(-1)!.state;
    expect(shortage).toBe(Math.max(...Object.values(s.metrics.provinceShortage).map((p) => p.bread ?? 0)));
    expect(inflation).toBeCloseTo(s.metrics.cpi / mid.history[0]!.state.metrics.cpi - 1, 12);
    expect(debt).toBeCloseTo(s.government.debt / (12 * s.metrics.gdp), 12);
  });

  it('закрытые рычаги и здания нельзя использовать', () => {
    const closed: Level = { ...harvest, levers: ['keyRate'], buildings: ['warehouse'] };
    expect(isAllowed(closed, { type: 'setKeyRate', rate: 0.1 }, data)).toBe(true);
    expect(isAllowed(closed, { type: 'setPriceCeiling', good: 'bread', price: 1 }, data)).toBe(false);
    expect(isAllowed(closed, { type: 'reserveBuy', good: 'grain', province: 'north', quantity: 1 }, data)).toBe(false);
    expect(isAllowed(closed, { type: 'buildStorage', building: 'warehouse', province: 'north' }, data)).toBe(true);
    expect(isAllowed(closed, { type: 'buildStorage', building: 'elevator', province: 'north' }, data)).toBe(false);
    expect(isAllowed(closed, { type: 'addRoadLane', route: 'x' }, data)).toBe(false);
    expect(isAllowed(closed, { type: 'buildStateFleet' }, data)).toBe(false);
    expect(isAllowed(harvest, { type: 'shock', shock: 'harvestFailure' }, data)).toBe(false);
  });

  it('уровень детерминирован: тот же seed и решения — та же история', () => {
    expect(play(harvest).history.map((h) => h.state)).toEqual(passive.history.map((h) => h.state));
  });
});
