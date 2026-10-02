// Труд и зарплаты (GDD 5.7).

import type { Balance } from '../../data/schemas';
import { makeCauseEvent, type CauseEvent } from '../causes';

/** Если труда на все планы не хватает, все планы урезаются в одной пропорции. */
export function laborScale(required: number, laborForce: number): number {
  return required > laborForce && required > 0 ? laborForce / required : 1;
}

export function unemploymentRate(employment: number, laborForce: number): number {
  return laborForce > 0 ? 1 - employment / laborForce : 0;
}

/**
 * w(t+1) = w × (1 + φ × (u* − u) + π_e), но не ниже w × (1 − maxMonthlyWageCut).
 * Вклады: разрыв безработицы, ожидания и «липкость» зарплат вниз (если ограничение сработало).
 */
export function nextWage(
  wage: number,
  unemployment: number,
  expectedInflation: number,
  labor: Balance['labor'],
  turn: number,
): { wage: number; cause: CauseEvent } {
  const contributions: Record<string, number> = {
    'labor.unemploymentGap': wage * labor.wageAdjustSpeed * (labor.naturalUnemployment - unemployment),
    expectations: wage * expectedInflation,
  };
  const raw = contributions['labor.unemploymentGap']! + contributions.expectations!;
  const floor = -wage * labor.maxMonthlyWageCut;
  if (raw < floor) contributions['labor.stickyWages'] = floor - raw;
  const cause = makeCauseEvent(turn, 'wage', contributions);
  return { wage: wage + cause.delta, cause };
}
