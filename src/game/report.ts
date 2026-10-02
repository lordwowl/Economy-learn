// Отчёт уровня (GDD 6, 7): итог, цели и причинная цепочка «решение → итог» из журнала за весь уровень.
// Цепочка строится автоматически: от показателя цели спускаемся по главной причине его изменения
// (ИПЦ → цена хлеба → вход «мука» → цена муки → …), пока причина не станет «листом» (наценка, потолок, зарплата…).

import type { Balance, Level } from '../data';
import { aggregate, type Cause } from '../sim/causes';
import type { Action } from '../sim';
import { evaluateLevel, type LevelStatus } from './level';
import type { TurnRecord } from './session';

/** Глубина цепочки: дальше текст перестаёт читаться. */
const MAX_DEPTH = 5;
/** Сколько цепочек в отчёте. */
const MAX_CHAINS = 2;

export interface ChainLink {
  /** Метрика журнала: "cpi", "price.bread", "wage", … */
  metric: string;
  /** Изменение за уровень. */
  delta: number;
  /** Главная причина изменения (в ту же сторону). */
  cause: Cause;
}

export interface Dated {
  /** Месяц, который дал ход с этим решением или событием. */
  turn: number;
  action: Action;
}

export interface Chain {
  /** Звенья от итога к первопричине: links[0] — показатель цели. */
  links: ChainLink[];
  /** Решения игрока, напрямую задающие первопричину (последнее звено). */
  decisions: Dated[];
}

export interface LevelReport {
  status: LevelStatus;
  chains: Chain[];
  decisions: Dated[];
  events: Dated[];
}

/** Куда спускаться дальше: причина «цена товара» или «вход» — это изменение цены этого товара. */
function nextMetric(metric: string, ref: string): string | undefined {
  const good = /^(?:price|input)\.([^.]+)$/.exec(ref)?.[1];
  if (good !== undefined) return `price.${good}`;
  if (ref === 'wage' && metric.startsWith('price.')) return 'wage';
  return undefined;
}

/** Главная причина: наибольший вклад в сторону изменения. */
function mainCause(causes: readonly Cause[], delta: number): Cause | undefined {
  let best: Cause | undefined;
  for (const c of causes) {
    if (Math.sign(c.value) !== Math.sign(delta)) continue;
    if (!best || Math.abs(c.value) > Math.abs(best.value)) best = c;
  }
  return best;
}

/** Цепочка главных причин изменения метрики за все ходы истории. */
export function causalChain(history: readonly TurnRecord[], metric: string): ChainLink[] {
  const events = history.flatMap((h) => h.causes);
  const links: ChainLink[] = [];
  const visited = new Set<string>();
  let current: string | undefined = metric;
  while (current !== undefined && links.length < MAX_DEPTH && !visited.has(current)) {
    visited.add(current);
    const event = aggregate(events, current);
    if (event.delta === 0) break;
    const cause = mainCause(event.causes, event.delta);
    if (!cause) break;
    links.push({ metric: current, delta: event.delta, cause });
    current = nextMetric(current, cause.ref);
  }
  return links;
}

/** Причины журнала, которые решение задаёт напрямую (без посредников), — для связи «решение → цепочка». */
export function decisionRefs(action: Action, metric: string): string[] {
  const good = metric.startsWith('price.') ? metric.split('.')[1] : undefined;
  const inBudget = metric === 'budget.balance';
  switch (action.type) {
    case 'setPriceCeiling':
      return good === action.good ? ['priceCeiling', 'blackMarket'] : [];
    case 'setSubsidy':
      return good === action.good ? ['subsidy'] : inBudget ? ['subsidies'] : [];
    case 'setTax':
      return action.tax === 'sales' && good !== undefined ? ['tax.sales'] : inBudget ? [`tax.${action.tax}`] : [];
    case 'setTransfers':
      return inBudget ? ['transfers'] : [];
    case 'reserveBuy':
    case 'reserveRelease':
      return good === action.good ? ['reserve'] : inBudget ? ['reserve', 'reserveSales'] : [];
    case 'addRoadLane':
    case 'buildStorage':
    case 'buildStateFleet':
      return inBudget ? ['construction'] : [];
    case 'setKeyRate':
      return inBudget ? ['interest'] : [];
    case 'shock':
      return [];
  }
}

function dated(history: readonly TurnRecord[], pick: (h: TurnRecord) => Action[]): Dated[] {
  return history.flatMap((h) => pick(h).map((action) => ({ turn: h.state.turn, action })));
}

/** Метрика журнала, которой объясняется показатель цели (у дефицита и долга своей цепочки нет). */
function journalMetric(goalMetric: string): string | undefined {
  if (goalMetric === 'cpi' || goalMetric === 'inflationYoY') return 'cpi';
  if (goalMetric === 'unemployment') return 'unemployment';
  if (goalMetric === 'budgetBalance') return 'budget.balance';
  if (goalMetric === 'realWage') return 'wage';
  if (goalMetric.startsWith('price.')) return goalMetric;
  return undefined;
}

export function levelReport(level: Level, history: readonly TurnRecord[], balance: Balance): LevelReport {
  const decisions = dated(history, (h) => h.actions);
  const metrics: string[] = [];
  for (const goal of level.goals) {
    const m = goal.condition.kind === 'metric' ? journalMetric(goal.condition.metric) : undefined;
    if (m !== undefined && !metrics.includes(m)) metrics.push(m);
  }
  if (metrics.length === 0) metrics.push('cpi');
  const chains: Chain[] = [];
  for (const metric of metrics) {
    const links = causalChain(history, metric);
    if (links.length === 0) continue;
    const root = links.at(-1)!;
    chains.push({ links, decisions: decisions.filter((d) => decisionRefs(d.action, root.metric).includes(root.cause.ref)) });
    if (chains.length >= MAX_CHAINS) break;
  }
  return { status: evaluateLevel(level, history, balance), chains, decisions, events: dated(history, (h) => h.events) };
}
