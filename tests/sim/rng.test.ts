import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/sim/rng';

describe('Rng', () => {
  it('одинаковый seed — одинаковая последовательность', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('разные seed — разные последовательности', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(Array.from({ length: 5 }, () => a.next())).not.toEqual(Array.from({ length: 5 }, () => b.next()));
  });

  it('продолжается с сохранённого состояния', () => {
    const a = new Rng(7);
    a.next();
    a.next();
    const b = new Rng(a.state);
    expect(b.next()).toBe(a.next());
  });

  it('значения в [0, 1), int — в границах', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 1000; i++) {
      const x = rng.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = rng.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
  });
});
