// Ожидания (GDD 5.9). Динамика доверия C — в v0.3; пока C задаётся уровнем.

import type { Balance } from '../../data/schemas';
import { annualToMonthly } from '../units';

export function nextExpectations(
  adaptive: number,
  trust: number,
  actualInflation: number,
  expectations: Balance['expectations'],
): { adaptive: number; expected: number } {
  const nextAdaptive = expectations.adaptiveWeight * adaptive + (1 - expectations.adaptiveWeight) * actualInflation;
  const target = annualToMonthly(expectations.inflationTarget);
  return { adaptive: nextAdaptive, expected: trust * target + (1 - trust) * nextAdaptive };
}
