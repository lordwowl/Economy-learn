// Тексты для решений, «в пути» и сводки — из ru.json.

import type { GameData } from '../data';
import { deficitLevel, deficitMark } from '../render/model';
import { formatWhyLine } from '../game/explain';
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
      return t('decision.setTransfers', { value: money(action.perCapita, 2) });
    case 'setSubsidy':
      return t('decision.setSubsidy', { good: goodName(action.good), value: money(action.perUnit, 2) });
    case 'setPriceCeiling':
      return action.price === null
        ? t('decision.removePriceCeiling', { good: goodName(action.good) })
        : t('decision.setPriceCeiling', { good: goodName(action.good), value: money(action.price, 2) });
    case 'addRoadLane':
      return t('decision.addRoadLane', { route: routeName(state, action.route) });
    case 'buildStorage':
      return t('decision.buildStorage', { building: translate(`building.${action.building}`), province: provinceName(state, action.province) });
    case 'buildStateFleet':
      return t('decision.buildStateFleet');
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
      return t('pending.subsidy', { good: goodName(target), amount: signedMoney(item.amount, 2), turns });
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
      return t('summary.price', { good: goodName(item.target ?? ''), arrow: arrow(item.change), change: signed(item.change * 100) + '%', value: money(item.value, 2) });
    case 'wage':
      return t('summary.wage', { arrow: arrow(item.change), change: signed(item.change * 100) + '%', value: money(item.value, 2) });
    case 'budget':
      return t('summary.budget', { change: signedMoney(item.change), value: money(item.value) });
    case 'deficit':
      return t('summary.deficit', { province: provinceName(state, item.target ?? ''), marks: deficitMark(deficitLevel(item.value)), value: pct(item.value, 0) });
    case 'firmsOpened':
      return t('summary.firmsOpened', { change: item.change });
    case 'firmsClosed':
      return t('summary.firmsClosed', { change: item.change });
  }
}

export const whyText = formatWhyLine;
