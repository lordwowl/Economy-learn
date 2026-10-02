// Причинный журнал (GDD 6). Каждое изменение метрики раскладывается на вклады; сумма вкладов = изменение.

export interface Cause {
  /** Ключ причины: "input.flour", "wage", "markup", "expectations", "price.bread", … Тексты — по шаблонам (M6). */
  ref: string;
  /** Абсолютный вклад в изменение метрики. */
  value: number;
  /** Доля в изменении: value / delta (0, если delta = 0). Может быть отрицательной. */
  share: number;
}

export interface CauseEvent {
  id: string;
  turn: number;
  /** "price.bread", "price.firm.bakery-north-1", "cpi", "wage", … */
  metric: string;
  delta: number;
  causes: Cause[];
}

/** Разложение величины на слагаемые: Σ значений = величина. */
export type Breakdown = Record<string, number>;

export function sumBreakdown(breakdown: Breakdown): number {
  let total = 0;
  for (const value of Object.values(breakdown)) total += value;
  return total;
}

export function makeCauseEvent(turn: number, metric: string, contributions: Breakdown): CauseEvent {
  const delta = sumBreakdown(contributions);
  const causes = Object.entries(contributions)
    .filter(([, value]) => value !== 0)
    .map(([ref, value]) => ({ ref, value, share: delta === 0 ? 0 : value / delta }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.ref.localeCompare(b.ref));
  return { id: `${turn}:${metric}`, turn, metric, delta, causes };
}

/** Событие изменения величины, заданной разложением: вклад каждой причины = её изменение. */
export function breakdownChange(turn: number, metric: string, before: Breakdown, after: Breakdown): CauseEvent {
  const contributions: Breakdown = {};
  for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
    contributions[ref] = (after[ref] ?? 0) - (before[ref] ?? 0);
  }
  return makeCauseEvent(turn, metric, contributions);
}
