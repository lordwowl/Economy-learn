// Перевод единиц. Ход = 1 месяц; ставки и цели в balance.json — годовые.

export const MONTHS_PER_YEAR = 12;

export function annualToMonthly(annualRate: number): number {
  return (1 + annualRate) ** (1 / MONTHS_PER_YEAR) - 1;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}
