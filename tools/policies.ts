// Боты-политики для балансировки без UI (CLAUDE.md): sim-runner и тесты прогоняют уровень с разными стратегиями.

import type { GameData } from '../src/data';
import type { Action, WorldState } from '../src/sim';

/** Решения бота на ход `turn` по состоянию перед этим ходом. */
export type Policy = (state: WorldState, turn: number, data: GameData) => Action[];

/** Ход, на котором боты принимают своё решение (после первого «спокойного» хода). */
export const DECISION_TURN = 2;

/** Сдвиги ставки ботов, годовые доли. */
const HAWK_RATE_STEP = 0.06;
const DOVE_RATE_STEP = 0.04;
/** Потолок бота ceiling — доля текущей цены хлеба. */
const CEILING_SHARE = 0.85;
const CEILING_GOOD = 'bread';

/** Ход, на котором действуют «уровневые» боты (сразу, с первого месяца). */
const LEVEL_TURN = 1;
/** builder: две госмельницы — в центре и на севере (узкое место уровня «Цепочка»). */
const BUILDER_MILLS = ['center', 'north'];
/** reserve: сколько зерна из резерва продавать в каждой провинции за ход, пока идёт шок или зерно дорогое. */
const RESERVE_RELEASE = 60;
/** reserve: «зерно дорогое» — цена выше стартовой больше чем на эту долю (0 — просто выше стартовой). */
const RESERVE_PRICE_TRIGGER = 0;
/** gradual: на сколько поднимать потолок каждые два хода и с какого хода снять совсем. */
const GRADUAL_STEP = 0.06;
const GRADUAL_LIFT_TURN = 7;

export const policies: Record<string, Policy> = {
  passive: () => [],
  hawk: (state, turn) => (turn === DECISION_TURN ? [{ type: 'setKeyRate', rate: state.keyRate + HAWK_RATE_STEP }] : []),
  dove: (state, turn) => (turn === DECISION_TURN ? [{ type: 'setKeyRate', rate: Math.max(0, state.keyRate - DOVE_RATE_STEP) }] : []),
  ceiling: (state, turn) => {
    const price = state.market[CEILING_GOOD]?.price;
    if (turn !== DECISION_TURN || price === undefined) return [];
    return [{ type: 'setPriceCeiling', good: CEILING_GOOD, price: price * CEILING_SHARE }];
  },
  /** Госпредприятия в узком месте цепочки (уровень 3). */
  builder: (_state, turn) => (turn === LEVEL_TURN ? BUILDER_MILLS.map((province): Action => ({ type: 'buildStateFirm', building: 'mill', province })) : []),
  /** Пока действует шок или зерно дорогое, понемногу продаёт зерно из госрезерва (уровень 5). */
  reserve: (state) => {
    const grain = state.market.grain;
    const expensive = grain !== undefined && grain.price > grain.referencePrice * (1 + RESERVE_PRICE_TRIGGER);
    if (state.activeShocks.length === 0 && !expensive) return [];
    return Object.entries(state.reserve.stock).flatMap(([province, stock]): Action[] => {
      const grain = stock.grain ?? 0;
      return grain > 0 ? [{ type: 'reserveRelease', good: 'grain', province, quantity: Math.min(RESERVE_RELEASE, grain) }] : [];
    });
  },
  /** Сразу снимает все потолки цен (уровень 6). */
  lift: (state, turn) =>
    turn === LEVEL_TURN ? Object.keys(state.government.priceCeilings).map((good): Action => ({ type: 'setPriceCeiling', good, price: null })) : [],
  /** Поднимает потолки постепенно и снимает их к GRADUAL_LIFT_TURN (уровень 6). */
  gradual: (state, turn) => {
    if (turn % 2 === 0) return [];
    return Object.entries(state.government.priceCeilings).map(
      ([good, price]): Action => ({
        type: 'setPriceCeiling',
        good,
        price: turn >= GRADUAL_LIFT_TURN ? null : Math.round(price * (1 + GRADUAL_STEP)),
      }),
    );
  },
  /** Возвращает ставку к нейтральной (уровень 9). */
  neutral: (state, turn, data) =>
    turn === LEVEL_TURN && state.keyRate !== data.balance.demand.neutralRate ? [{ type: 'setKeyRate', rate: data.balance.demand.neutralRate }] : [],
};

export const policyNames = Object.keys(policies);
