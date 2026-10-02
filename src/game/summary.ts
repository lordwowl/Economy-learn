// Сводка месяца (GDD 4): 3–5 главных изменений с причинами из журнала.

import type { CauseEvent } from '../sim/causes';
import type { WorldState } from '../sim';
import { why, type ExplainContext, type WhyLine } from './explain';

export type SummaryKind = 'cpi' | 'unemployment' | 'price' | 'wage' | 'budget' | 'deficit' | 'firmsOpened' | 'firmsClosed';

export interface SummaryItem {
  kind: SummaryKind;
  /** Товар или провинция, если есть. */
  target?: string;
  /** Изменение: доля (цены, ИПЦ, зарплата), п.п. (безработица), сумма (бюджет), уровень (дефицит), число фирм. */
  change: number;
  /** Значение после хода. */
  value: number;
  /** Насколько изменение заметно: ≥ 1 — попадает в сводку. */
  importance: number;
  /** Главные причины («Почему?»). */
  causes: WhyLine[];
}

/** Что считается заметным за месяц (визуальные пороги сводки, не формулы модели). */
const NOTICEABLE = {
  cpi: 0.003,
  unemployment: 0.005,
  price: 0.01,
  wage: 0.01,
  budgetShareOfRevenue: 0.05,
  /** Дефицит в провинции, о котором стоит сказать (совпадает с первым уровнем тепловой карты). */
  deficit: 0.05,
} as const;
const MAX_ITEMS = 5;
const MIN_ITEMS = 3;
const CAUSES_PER_ITEM = 2;

export function monthSummary(
  prev: WorldState,
  state: WorldState,
  causes: readonly CauseEvent[],
  ctx: ExplainContext,
  /** Товары, цены которых видит население (из balance.demand.goods). */
  consumerGoods: readonly string[],
): SummaryItem[] {
  const event = (metric: string) => causes.find((c) => c.metric === metric);
  const reasons = (metric: string) => {
    const e = event(metric);
    return e ? why(e, ctx, CAUSES_PER_ITEM) : [];
  };
  const items: SummaryItem[] = [];
  const rel = (now: number, before: number) => (before !== 0 ? now / before - 1 : 0);

  const cpi = rel(state.metrics.cpi, prev.metrics.cpi);
  items.push({ kind: 'cpi', change: cpi, value: state.metrics.cpi, importance: Math.abs(cpi) / NOTICEABLE.cpi, causes: reasons('cpi') });

  const du = state.metrics.unemployment - prev.metrics.unemployment;
  items.push({
    kind: 'unemployment',
    change: du,
    value: state.metrics.unemployment,
    importance: Math.abs(du) / NOTICEABLE.unemployment,
    causes: reasons('unemployment'),
  });

  for (const good of consumerGoods) {
    const now = state.market[good]?.price;
    const before = prev.market[good]?.price;
    if (now === undefined || before === undefined) continue;
    const change = rel(now, before);
    items.push({ kind: 'price', target: good, change, value: now, importance: Math.abs(change) / NOTICEABLE.price, causes: reasons(`price.${good}`) });
  }

  const wage = rel(state.wage, prev.wage);
  items.push({ kind: 'wage', change: wage, value: state.wage, importance: Math.abs(wage) / NOTICEABLE.wage, causes: reasons('wage') });

  const revenue = Object.values(state.government.revenue).reduce((a, b) => a + b, 0);
  const balance = state.metrics.budgetBalance;
  items.push({
    kind: 'budget',
    change: balance,
    value: state.government.debt,
    importance: revenue > 0 ? Math.abs(balance) / revenue / NOTICEABLE.budgetShareOfRevenue : 0,
    causes: reasons('budget.balance'),
  });

  for (const province of state.provinces) {
    const level = (s: WorldState) => Math.max(0, ...Object.values(s.metrics.provinceShortage[province.id] ?? {}));
    const now = level(state);
    const before = level(prev);
    if (now < NOTICEABLE.deficit && before < NOTICEABLE.deficit) continue;
    // Острый дефицит важнее всего; исчезнувший дефицит — тоже новость.
    items.push({ kind: 'deficit', target: province.id, change: now - before, value: now, importance: 1 + now / NOTICEABLE.deficit, causes: [] });
  }

  if (state.metrics.firmsOpened.length > 0) {
    items.push({ kind: 'firmsOpened', change: state.metrics.firmsOpened.length, value: state.firms.length, importance: 1, causes: [] });
  }
  if (state.metrics.firmsClosed.length > 0) {
    items.push({ kind: 'firmsClosed', change: state.metrics.firmsClosed.length, value: state.firms.length, importance: 2, causes: [] });
  }

  const sorted = items.sort((a, b) => b.importance - a.importance);
  const noticeable = sorted.filter((i) => i.importance >= 1);
  return (noticeable.length >= MIN_ITEMS ? noticeable : sorted.slice(0, MIN_ITEMS)).slice(0, MAX_ITEMS);
}
