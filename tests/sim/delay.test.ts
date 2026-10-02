import { describe, expect, it } from 'vitest';
import { emptyQueue, schedule, spreadOverLag, takeDue } from '../../src/sim/delay';

describe('DelayQueue', () => {
  it('отдаёт созревшие эффекты по ходу и порядку постановки', () => {
    let q = emptyQueue<string>();
    q = schedule(q, 3, 'c');
    q = schedule(q, 2, 'a');
    q = schedule(q, 2, 'b');
    q = schedule(q, 5, 'later');
    const { due, queue } = takeDue(q, 3);
    expect(due).toEqual(['a', 'b', 'c']);
    expect(queue.items.map((i) => i.effect)).toEqual(['later']);
  });

  it('не мутирует исходную очередь', () => {
    const q = schedule(emptyQueue<number>(), 1, 1);
    takeDue(q, 1);
    schedule(q, 2, 2);
    expect(q.items).toHaveLength(1);
  });

  it('spreadOverLag делит изменение от первого до полного эффекта', () => {
    const parts = spreadOverLag(0.06, { first: 2, full: 4 }, 10);
    expect(parts.map((p) => p.turn)).toEqual([12, 13, 14]);
    expect(parts.reduce((s, p) => s + p.delta, 0)).toBeCloseTo(0.06, 12);
  });

  it('first = full — один эффект', () => {
    expect(spreadOverLag(1, { first: 1, full: 1 }, 0)).toEqual([{ turn: 1, delta: 1 }]);
  });
});
