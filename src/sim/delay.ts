// DelayQueue: отложенные эффекты решений (GDD 5.12). Хранится в состоянии мира, поэтому сериализуема.

import type { Lag } from '../data/schemas';

export interface Scheduled<E> {
  /** Ход, на котором эффект применяется. */
  turn: number;
  /** Порядковый номер постановки: эффекты одного хода применяются в порядке постановки. */
  seq: number;
  effect: E;
}

export interface DelayQueue<E> {
  nextSeq: number;
  items: Scheduled<E>[];
}

export function emptyQueue<E>(): DelayQueue<E> {
  return { nextSeq: 0, items: [] };
}

export function schedule<E>(queue: DelayQueue<E>, turn: number, effect: E): DelayQueue<E> {
  return {
    nextSeq: queue.nextSeq + 1,
    items: [...queue.items, { turn, seq: queue.nextSeq, effect }],
  };
}

/** Забирает эффекты с ходом ≤ turn в порядке (ход, порядок постановки). */
export function takeDue<E>(queue: DelayQueue<E>, turn: number): { due: E[]; queue: DelayQueue<E> } {
  const due = queue.items
    .filter((item) => item.turn <= turn)
    .sort((a, b) => a.turn - b.turn || a.seq - b.seq)
    .map((item) => item.effect);
  return { due, queue: { nextSeq: queue.nextSeq, items: queue.items.filter((item) => item.turn > turn) } };
}

/**
 * Делит изменение на равные части по ходам от «первого эффекта» до «полного» (включительно).
 * Решение на ходу now с лагом {first: 2, full: 4} даёт три части на ходах now+2, now+3, now+4.
 */
export function spreadOverLag(delta: number, lag: Lag, now: number): { turn: number; delta: number }[] {
  const parts = lag.full - lag.first + 1;
  return Array.from({ length: parts }, (_, i) => ({ turn: now + lag.first + i, delta: delta / parts }));
}
