// «В пути» (GDD 4): отложенные эффекты, которые игрок уже запустил, но результат ещё не пришёл.

import type { WorldState } from '../sim';

export type PendingKind = 'demandRate' | 'creditRate' | 'subsidy' | 'roadLane' | 'firm' | 'storage' | 'fleet';

export interface PendingItem {
  kind: PendingKind;
  /** Через сколько ходов эффект придёт полностью (1 = на следующем ходу). */
  turnsLeft: number;
  /** Для ставки и субсидии — сколько ещё изменится; для стройки — сколько единиц. */
  amount: number;
  /** id объекта: товар, дорога, фирма, склад, перевозчик. */
  target?: string;
}

/** Сгруппированные отложенные эффекты: одна строка на рычаг или объект. */
export function pendingItems(state: WorldState): PendingItem[] {
  const groups = new Map<string, PendingItem>();
  const put = (key: string, item: Omit<PendingItem, 'turnsLeft' | 'amount'>, turn: number, amount: number) => {
    const turnsLeft = turn - state.turn;
    const existing = groups.get(key);
    if (existing) {
      existing.turnsLeft = Math.max(existing.turnsLeft, turnsLeft);
      existing.amount += amount;
    } else {
      groups.set(key, { ...item, turnsLeft, amount });
    }
  };
  for (const { turn, effect } of state.pending.items) {
    switch (effect.type) {
      case 'demandRate':
      case 'creditRate':
        put(effect.type, { kind: effect.type }, turn, effect.delta);
        break;
      case 'subsidy':
        put(`subsidy.${effect.good}`, { kind: 'subsidy', target: effect.good }, turn, effect.delta);
        break;
      case 'roadLane':
        put(`road.${effect.route}`, { kind: 'roadLane', target: effect.route }, turn, 1);
        break;
      case 'firmReady':
        put(`firm.${effect.firm}`, { kind: 'firm', target: effect.firm }, turn, 1);
        break;
      case 'storageReady':
        put(`storage.${effect.storage}`, { kind: 'storage', target: effect.storage }, turn, 1);
        break;
      case 'fleetReady':
        put(`fleet.${effect.carrier}`, { kind: 'fleet', target: effect.carrier }, turn, 1);
        break;
    }
  }
  return [...groups.values()].sort((a, b) => a.turnsLeft - b.turnsLeft || a.kind.localeCompare(b.kind));
}
