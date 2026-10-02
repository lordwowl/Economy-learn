// Тексты для решений, «в пути» и сводки — из ru.json.

import type { Balance, GameData, GoalCondition } from '../data';
import { deficitLevel, deficitMark } from '../render/model';
import { causeLine, formatWhyLine, metricLabel, type ExplainContext } from '../game/explain';
import type { Defeat, GoalStatus } from '../game/level';
import type { ChainLink } from '../game/report';
import type { PendingItem } from '../game/pending';
import type { SummaryItem } from '../game/summary';
import { t, translate } from '../i18n';
import type { Action, WorldState } from '../sim';
import { arrow, money, num, pct, signed, signedMoney } from './format';

export const goodName = (good: string) => translate(`good.${good}`);

export function provinceName(state: WorldState, id: string): string {
  return translate(state.provinces.find((p) => p.id === id)?.nameKey ?? id);
}

export function routeName(state: WorldState, id: string): string {
  const route = state.routes.find((r) => r.id === id);
  return route ? t('route.name', { a: provinceName(state, route.a), b: provinceName(state, route.b) }) : id;
}

export function firmName(state: WorldState, id: string): string {
  const firm = state.firms.find((f) => f.id === id);
  return firm ? `${translate(`building.${firm.building}`)}, ${provinceName(state, firm.province)}` : id;
}

export function storageName(state: WorldState, id: string): string {
  const storage = state.reserve.storages.find((s) => s.id === id);
  return storage ? `${translate(`building.${storage.building}`)}, ${provinceName(state, storage.province)}` : id;
}

export function describeDecision(action: Action, state: WorldState, data: GameData): string {
  switch (action.type) {
    case 'setKeyRate':
      return t('decision.setKeyRate', { value: pct(action.rate) });
    case 'setTax':
      return translate(`decision.setTax.${action.tax}`, { value: pct(action.rate, 0) });
    case 'setTransfers':
      return t('decision.setTransfers', { value: money(action.perCapita) });
    case 'setSubsidy':
      return t('decision.setSubsidy', { good: goodName(action.good), value: money(action.perUnit) });
    case 'setPriceCeiling':
      return action.price === null
        ? t('decision.removePriceCeiling', { good: goodName(action.good) })
        : t('decision.setPriceCeiling', { good: goodName(action.good), value: money(action.price) });
    case 'addRoadLane':
      return t('decision.addRoadLane', { route: routeName(state, action.route) });
    case 'buildStorage':
      return t('decision.buildStorage', { building: translate(`building.${action.building}`), province: provinceName(state, action.province) });
    case 'buildStateFleet':
      return t('decision.buildStateFleet');
    case 'buildStateFirm':
      return t('decision.buildStateFirm', { building: translate(`building.${action.building}`), province: provinceName(state, action.province) });
    case 'reserveBuy':
    case 'reserveRelease':
      return t(action.type === 'reserveBuy' ? 'decision.reserveBuy' : 'decision.reserveRelease', {
        good: goodName(action.good),
        quantity: num(action.quantity),
        province: provinceName(state, action.province),
      });
    case 'shock':
      return t('decision.shock', { shock: translate(data.shocks.find((s) => s.id === action.shock)?.nameKey ?? action.shock) });
  }
}

export function describePending(item: PendingItem, state: WorldState): string {
  const turns = item.turnsLeft;
  const target = item.target ?? '';
  switch (item.kind) {
    case 'demandRate':
    case 'creditRate':
      return t(item.kind === 'demandRate' ? 'pending.demandRate' : 'pending.creditRate', { amount: signed(item.amount * 100), turns });
    case 'subsidy':
      return t('pending.subsidy', { good: goodName(target), amount: signedMoney(item.amount), turns });
    case 'roadLane':
      return t('pending.roadLane', { route: routeName(state, target), turns });
    case 'firm':
      return t('pending.firm', { firm: firmName(state, target), turns });
    case 'storage':
      return t('pending.storage', { storage: storageName(state, target), turns });
    case 'fleet':
      return t('pending.fleet', { amount: item.amount, turns });
  }
}

export function describeSummary(item: SummaryItem, state: WorldState): string {
  switch (item.kind) {
    case 'cpi':
      return t('summary.cpi', { arrow: arrow(item.change), change: signed(item.change * 100) + '%', value: num(item.value, 1) });
    case 'unemployment':
      return t('summary.unemployment', { arrow: arrow(item.change), change: signed(item.change * 100), value: pct(item.value) });
    case 'price':
      return t('summary.price', {
        good: goodName(item.target ?? ''),
        arrow: arrow(item.change),
        change: signed(item.change * 100) + '%',
        value: money(item.value),
      });
    case 'wage':
      return t('summary.wage', { arrow: arrow(item.change), change: signed(item.change * 100) + '%', value: money(item.value) });
    case 'budget':
      return t('summary.budget', { change: signedMoney(item.change), value: money(item.value) });
    case 'deficit':
      return t('summary.deficit', {
        province: provinceName(state, item.target ?? ''),
        marks: deficitMark(deficitLevel(item.value)),
        value: pct(item.value, 0),
      });
    case 'firmsOpened':
      return t('summary.firmsOpened', { change: item.change });
    case 'firmsClosed':
      return t('summary.firmsClosed', { change: item.change });
  }
}

export const whyText = formatWhyLine;

/** Доля в процентах: целые — без дробной части, иначе одна цифра. */
function share(value: number): string {
  const percent = value * 100;
  return pct(value, Math.abs(percent - Math.round(percent)) < 1e-9 ? 0 : 1);
}

const SHARE_METRICS = new Set(['unemployment', 'inflationYoY', 'debtToGdp', 'shortage', 'maxShortage']);

/** Значение показателя цели в его единицах: доли — в %, ИПЦ — числом, остальное — в колосах. */
export function goalValue(metric: string, value: number): string {
  const kind = metric.split('.')[0]!;
  if (SHARE_METRICS.has(kind)) return share(value);
  if (kind === 'cpi') return num(value, 1);
  if (kind === 'budgetBalance') return signedMoney(value);
  return money(value);
}

export function goalMetricName(metric: string): string {
  const [kind, good] = metric.split('.');
  return translate(`goal.metric.${kind}`, good !== undefined ? { good: goodName(good) } : {});
}

export function describeGoal(condition: GoalCondition): string {
  if (condition.kind === 'noDecision') return translate(`goal.noDecision.${condition.decision}`);
  const params = {
    metric: goalMetricName(condition.metric),
    op: t(condition.op === '<=' ? 'goal.op.le' : 'goal.op.ge'),
    value: goalValue(condition.metric, condition.value),
    from: condition.from ?? 1,
    turns: condition.turns ?? 1,
  };
  switch (condition.when) {
    case 'end':
      return t('goal.end', params);
    case 'always':
      return t(condition.from !== undefined && condition.from > 1 ? 'goal.alwaysFrom' : 'goal.always', params);
    case 'streak':
      return t('goal.streak', params);
  }
}

/** «✓ выполнено · сейчас 104,7». */
export function describeGoalStatus(status: GoalStatus): string {
  const parts = [translate(`goal.state.${status.state}`)];
  if (status.condition.kind === 'metric' && status.value !== undefined) {
    parts.push(t('goal.now', { value: goalValue(status.condition.metric, status.value) }));
  }
  if (status.streak !== undefined && status.state === 'pending') parts.push(t('goal.streakNow', { streak: status.streak }));
  return parts.join(' · ');
}

export function describeDefeat(defeat: Defeat, state: WorldState, balance: Balance): string {
  const c = balance.catastrophe;
  switch (defeat.reason) {
    case 'famine':
      return t('report.defeat.famine', {
        province: provinceName(state, defeat.province),
        good: goodName(c.famineGood),
        share: share(c.famineShortage),
        turns: c.famineTurns,
        turn: defeat.turn,
      });
    case 'default':
      return t('report.defeat.default', { share: share(c.defaultDebtToAnnualGdp), turn: defeat.turn });
    case 'trust':
      return t('report.defeat.trust', { turn: defeat.turn });
  }
}

/** Изменение метрики журнала за уровень в понятных единицах: ИПЦ — в пунктах, цены и зарплата — в %, безработица — в п.п. */
export function chainChange(metric: string, value: number, start: WorldState): string {
  const relative = (base: number | undefined) => (base ? `${signed((value / base) * 100)}%` : signed(value, 2));
  if (metric === 'cpi') return t('report.points', { value: signed(value) });
  if (metric === 'unemployment') return t('report.pp', { value: signed(value * 100) });
  if (metric === 'budget.balance') return signedMoney(value);
  if (metric === 'wage') return relative(start.wage);
  if (metric.startsWith('price.')) return relative(start.market[metric.split('.')[1]!]?.price);
  if (metric.startsWith('supplyLoss.')) return t('report.units', { value: num(value) });
  return signed(value, 2);
}

/** Звено цепочки: «Цена «Хлеб» ▲ +31,6%» и «Главная причина: Фирмы подняли наценку (+24,7%)». */
export function describeChainLink(link: ChainLink, start: WorldState, ctx: ExplainContext): { title: string; cause: string } {
  return {
    title: link.metric.startsWith('supplyLoss.')
      ? t('report.lossTitle', { metric: metricLabel(link.metric, ctx), value: chainChange(link.metric, link.delta, start) })
      : `${metricLabel(link.metric, ctx)} ${arrow(link.delta)} ${chainChange(link.metric, link.delta, start)}`,
    cause: t('report.mainCause', { cause: causeLine(link.metric, link.cause, ctx).text, value: chainChange(link.metric, link.cause.value, start) }),
  };
}
