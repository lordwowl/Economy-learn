// Ценообразование «себестоимость + наценка» (GDD 5.4) с точным разложением цены.
//
// P(t+1) = (1 − α)·P + α·P* + γ·π_e·P,  P* = c·(1 + m),  c = Σ c_k.
// Цена хранится как сумма компонент; каждая компонента обновляется той же формулой:
//   comp_k(t+1)      = (1 − α)·comp_k(t) + α·c_k        — входы, зарплата
//   markup(t+1)      = (1 − α)·markup(t) + α·c·m
//   expectations(t+1)= (1 − α)·expectations(t) + γ·π_e·P
// Поэтому Σ компонент = P(t+1) точно, и изменение цены раскладывается на вклады (Рентген товара).

import type { Balance, Recipe } from '../../data/schemas';
import type { Breakdown } from '../causes';
import type { GoodId } from '../state';
import { clamp } from '../units';

export const COMPONENT = {
  input: (good: GoodId) => `input.${good}`,
  wage: 'wage',
  markup: 'markup',
  expectations: 'expectations',
} as const;

/** Себестоимость единицы выхода по компонентам (c_k). */
export function unitCostBreakdown(recipe: Recipe, prices: Record<GoodId, number>, wage: number): Breakdown {
  const perOutput = 1 / recipe.output.amount;
  const cost: Breakdown = {};
  for (const input of recipe.inputs) {
    cost[COMPONENT.input(input.good)] = input.amount * (prices[input.good] ?? 0) * perOutput;
  }
  cost[COMPONENT.wage] = recipe.labor * wage * perOutput;
  return cost;
}

/** m(t+1) = clamp(m + β × (cov_target − cov) / cov_target, m_min, m_max). */
export function nextMarkup(markup: number, cov: number, firms: Balance['firms']): number {
  const adjusted = markup + (firms.markupAdjustSpeed * (firms.targetCoverage - cov)) / firms.targetCoverage;
  return clamp(adjusted, firms.markupMin, firms.markupMax);
}

export function nextPriceBreakdown(
  current: Breakdown,
  unitCost: Breakdown,
  markup: number,
  expectedInflation: number,
  firms: Balance['firms'],
): Breakdown {
  const alpha = firms.priceStickiness;
  let price = 0;
  let cost = 0;
  for (const v of Object.values(current)) price += v;
  for (const v of Object.values(unitCost)) cost += v;

  const next: Breakdown = {};
  for (const [ref, value] of Object.entries(current)) next[ref] = (1 - alpha) * value;
  for (const [ref, value] of Object.entries(unitCost)) next[ref] = (next[ref] ?? 0) + alpha * value;
  next[COMPONENT.markup] = (next[COMPONENT.markup] ?? 0) + alpha * cost * markup;
  next[COMPONENT.expectations] =
    (next[COMPONENT.expectations] ?? 0) + firms.expectedInflationPassThrough * expectedInflation * price;
  return next;
}
