// Детерминированный генератор (mulberry32). Вся случайность симуляции — только отсюда.

export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Текущее внутреннее состояние — для сохранений: new Rng(rng.state) продолжит ту же последовательность. */
  get state(): number {
    return this.s;
  }

  /** Равномерно в [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Равномерно в [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Целое в [min, max] включительно. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
}
