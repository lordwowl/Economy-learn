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

export const policies: Record<string, Policy> = {
  passive: () => [],
  hawk: (state, turn) => (turn === DECISION_TURN ? [{ type: 'setKeyRate', rate: state.keyRate + HAWK_RATE_STEP }] : []),
  dove: (state, turn) => (turn === DECISION_TURN ? [{ type: 'setKeyRate', rate: Math.max(0, state.keyRate - DOVE_RATE_STEP) }] : []),
  ceiling: (state, turn) => {
    const price = state.market[CEILING_GOOD]?.price;
    if (turn !== DECISION_TURN || price === undefined) return [];
    return [{ type: 'setPriceCeiling', good: CEILING_GOOD, price: price * CEILING_SHARE }];
  },
};

export const policyNames = Object.keys(policies);
