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

/** w(t+1) = w × (1 + φ × (u* − u) + π_e). Вклады: разрыв безработицы и ожидания. */
export function nextWage(
  wage: number,
  unemployment: number,
  expectedInflation: number,
  labor: Balance['labor'],
  turn: number,
): { wage: number; cause: CauseEvent } {
  const contributions = {
    'labor.unemploymentGap': wage * labor.wageAdjustSpeed * (labor.naturalUnemployment - unemployment),
    expectations: wage * expectedInflation,
  };
  const cause = makeCauseEvent(turn, 'wage', contributions);
  return { wage: Math.max(0, wage + cause.delta), cause };
}
