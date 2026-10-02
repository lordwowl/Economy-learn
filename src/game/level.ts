// Контроллер уровня (GDD 4, 9): шоки по ходам, доступные рычаги, цели и звёзды, проигрыш при катастрофе.

import type { Balance, GameData, GoalCondition, Level, Lever, Scenario } from '../data';
import type { Action, WorldState } from '../sim';
import { createSession, currentState, endTurn, type Session, type TurnRecord } from './session';

/** Сравнение с порогом цели без ошибок округления. */
const EPSILON = 1e-9;

export function startLevel(data: GameData, level: Level, scenario: Scenario): Session {
  return createSession(data, scenario, level.seed);
}

/** Шоки уровня, срабатывающие в ходе, который даёт месяц `turn`. */
export function levelEvents(level: Level, turn: number): Action[] {
  return level.events.filter((e) => e.turn === turn).map((e): Action => ({ type: 'shock', shock: e.shock }));
}

const LEVER_OF: Partial<Record<Action['type'], Lever>> = {
  setKeyRate: 'keyRate',
  setTax: 'taxes',
  setTransfers: 'transfers',
  setSubsidy: 'subsidies',
  setPriceCeiling: 'priceCeilings',
  reserveBuy: 'reserve',
  reserveRelease: 'reserve',
};

/** Может ли игрок принять это решение на уровне (рычаг открыт, здание разрешено). */
export function isAllowed(level: Level, action: Action, data: GameData): boolean {
  const buildingOf = (kind: 'route' | 'fleet') => data.buildings.find((b) => b.kind === kind)?.id ?? '';
  switch (action.type) {
    case 'addRoadLane':
      return level.buildings.includes(buildingOf('route'));
    case 'buildStateFleet':
      return level.buildings.includes(buildingOf('fleet'));
    case 'buildStorage':
    case 'buildStateFirm':
      return level.buildings.includes(action.building);
    case 'shock':
      return false;
    default: {
      const lever = LEVER_OF[action.type];
      return lever !== undefined && level.levers.includes(lever);
    }
  }
}

/** Значение показателя цели в состоянии (см. goalMetric в схеме уровня). */
export function goalMetricValue(metric: string, state: WorldState, start: WorldState): number {
  const m = state.metrics;
  switch (metric) {
    case 'cpi':
      return m.cpi;
    case 'inflationYoY':
      return m.inflationYoY ?? m.cpi / start.metrics.cpi - 1;
    case 'unemployment':
      return m.unemployment;
    case 'budgetBalance':
      return m.budgetBalance;
    case 'debtToGdp':
      return m.gdp > 0 ? state.government.debt / (12 * m.gdp) : state.government.debt > 0 ? Infinity : 0;
    case 'realWage':
      return m.realWage;
  }
  const [kind, good = ''] = metric.split('.');
  switch (kind) {
    case 'shortage':
      return m.shortage[good] ?? 0;
    case 'maxShortage':
      return Math.max(0, ...Object.values(m.provinceShortage).map((p) => p[good] ?? 0));
    case 'price':
      return state.market[good]?.price ?? 0;
    default:
      throw new Error(`Неизвестный показатель цели "${metric}"`);
  }
}

export type GoalState = 'met' | 'failed' | 'pending';

export interface GoalStatus {
  id: string;
  star: 1 | 2 | 3;
  condition: GoalCondition;
  state: GoalState;
  /** Текущее значение показателя (для целей по показателю). */
  value?: number;
  /** Для streak: сколько ходов подряд условие выполняется сейчас. */
  streak?: number;
}

export type Defeat = { reason: 'famine'; turn: number; province: string } | { reason: 'default'; turn: number } | { reason: 'trust'; turn: number };

export interface LevelStatus {
  /** Сыгранный месяц. */
  turn: number;
  outcome: 'playing' | 'completed' | 'defeated';
  defeat?: Defeat;
  goals: GoalStatus[];
  /** Звёзды: только у завершённого уровня, иначе 0. */
  stars: 0 | 1 | 2 | 3;
}

/** Первая катастрофа (GDD 4): голод, дефолт, потеря доверия. */
export function findDefeat(states: readonly WorldState[], balance: Balance): Defeat | undefined {
  const c = balance.catastrophe;
  const famineStreak = new Map<string, number>();
  for (const state of states) {
    if (state.turn === 0) continue;
    for (const [province, byGood] of Object.entries(state.metrics.provinceShortage)) {
      const streak = (byGood[c.famineGood] ?? 0) >= c.famineShortage - EPSILON ? (famineStreak.get(province) ?? 0) + 1 : 0;
      famineStreak.set(province, streak);
      if (streak >= c.famineTurns) return { reason: 'famine', turn: state.turn, province };
    }
    const annualGdp = 12 * state.metrics.gdp;
    if (state.government.debt > 0 && (annualGdp <= 0 || state.government.debt / annualGdp >= c.defaultDebtToAnnualGdp)) {
      return { reason: 'default', turn: state.turn };
    }
    if (state.expectations.trust <= c.minTrust + EPSILON) return { reason: 'trust', turn: state.turn };
  }
  return undefined;
}

function holds(op: '<=' | '>=', value: number, threshold: number): boolean {
  return op === '<=' ? value <= threshold + EPSILON : value >= threshold - EPSILON;
}

/** Решение считается принятым, если оно что-то включает (снять потолок — не «ввести потолок»). */
function usedDecision(history: readonly TurnRecord[], decision: string): boolean {
  return history.some((h) => h.actions.some((a) => a.type === decision && !(a.type === 'setPriceCeiling' && a.price === null)));
}

function evaluateGoal(goal: Level['goals'][number], level: Level, history: readonly TurnRecord[], finished: boolean): GoalStatus {
  const base = { id: goal.id, star: goal.star, condition: goal.condition };
  const c = goal.condition;
  if (c.kind === 'noDecision') {
    return { ...base, state: usedDecision(history, c.decision) ? 'failed' : finished ? 'met' : 'pending' };
  }
  const start = history[0]!.state;
  const played = history.slice(1).map((h) => h.state);
  const valueOf = (s: WorldState) => goalMetricValue(c.metric, s, start);
  const value = valueOf(history.at(-1)!.state);
  const from = c.from ?? 1;
  switch (c.when) {
    case 'end':
      return { ...base, value, state: finished ? (holds(c.op, value, c.value) ? 'met' : 'failed') : 'pending' };
    case 'always': {
      const violated = played.some((s) => s.turn >= from && !holds(c.op, valueOf(s), c.value));
      return { ...base, value, state: violated ? 'failed' : finished ? 'met' : 'pending' };
    }
    case 'streak': {
      const need = c.turns ?? 1;
      let streak = 0;
      let reached = false;
      for (const s of played) {
        if (s.turn < from) continue;
        streak = holds(c.op, valueOf(s), c.value) ? streak + 1 : 0;
        if (streak >= need) reached = true;
      }
      const turn = history.at(-1)!.state.turn;
      const left = level.turns - Math.max(turn, from - 1);
      const state: GoalState = reached ? 'met' : finished || streak + left < need ? 'failed' : 'pending';
      return { ...base, value, streak, state };
    }
  }
}

/** Состояние уровня по истории ходов: цели, катастрофа, конец и звёзды. */
export function evaluateLevel(level: Level, history: readonly TurnRecord[], balance: Balance): LevelStatus {
  const states = history.map((h) => h.state);
  const turn = states.at(-1)!.turn;
  const defeat = findDefeat(states, balance);
  const finished = defeat !== undefined || turn >= level.turns;
  // При катастрофе уровень не пройден: всё, что не достигнуто до неё, — провалено.
  const goals = level.goals
    .map((g) => evaluateGoal(g, level, history, finished && !defeat))
    .map((g): GoalStatus => (defeat && g.state === 'pending' ? { ...g, state: 'failed' } : g));
  let stars: LevelStatus['stars'] = 0;
  if (finished && !defeat) {
    for (const star of [1, 2, 3] as const) {
      if (!goals.filter((g) => g.star === star).every((g) => g.state === 'met')) break;
      stars = star;
    }
  }
  return {
    turn,
    outcome: defeat ? 'defeated' : finished ? 'completed' : 'playing',
    ...(defeat ? { defeat } : {}),
    goals,
    stars,
  };
}

/** Ход(ы) уровня: решения игрока + шоки по сценарию; останавливается на конце уровня или катастрофе. */
export function advanceLevel(session: Session, data: GameData, level: Level, turns: number): Session {
  let s = session;
  for (let i = 0; i < turns; i++) {
    if (evaluateLevel(level, s.history, data.balance).outcome !== 'playing') break;
    s = endTurn(s, data, levelEvents(level, currentState(s).turn + 1));
  }
  return s;
}
