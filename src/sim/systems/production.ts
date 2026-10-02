// Производство (GDD 5.3): план от ожидаемых заказов и покрытия, выпуск ограничен мощностью, входами, трудом, деньгами.

import type { Balance, Recipe } from '../../data/schemas';
import type { Breakdown } from '../causes';
import type { Firm, GoodId } from '../state';
import { clamp, mean } from '../units';

/** Покрытие = запас / средние заказы, ограничено сверху coverageCap. */
export function coverage(stock: number, averageOrders: number, firms: Balance['firms']): number {
  if (averageOrders > 0) return Math.min(firms.coverageCap, stock / averageOrders);
  return stock > 0 ? firms.coverageCap : firms.targetCoverage;
}

/** Желаемый выпуск в запусках рецепта без ограничения мощностью: ожидаемые_продажи × (1 + k × (целевое_покрытие − покрытие)). */
export function desiredRuns(firm: Firm, recipe: Recipe, firms: Balance['firms']): number {
  const expectedSales = mean(firm.ordersHistory);
  const stock = firm.inventory[recipe.output.good] ?? 0;
  const cov = coverage(stock, expectedSales, firms);
  return Math.max(0, expectedSales * (1 + firms.inventoryAdjustSpeed * (firms.targetCoverage - cov))) / recipe.output.amount;
}

/** План выпуска в запусках рецепта: желаемый выпуск, не больше мощности. */
export function plannedRuns(firm: Firm, recipe: Recipe, firms: Balance['firms']): number {
  return Math.min(firm.capacity, desiredRuns(firm, recipe, firms));
}

/** Стоимость одного запуска по рыночным ценам: входы + зарплата. */
export function costPerRun(recipe: Recipe, prices: Record<GoodId, number>, wage: number): number {
  let cost = recipe.labor * wage;
  for (const input of recipe.inputs) cost += input.amount * (prices[input.good] ?? 0);
  return cost;
}

/** Сколько запусков фирма может оплатить: деньги + стоимость уже лежащих на складе входов. */
export function affordableRuns(firm: Firm, recipe: Recipe, prices: Record<GoodId, number>, wage: number): number {
  const perRun = costPerRun(recipe, prices, wage);
  if (perRun <= 0) return Number.POSITIVE_INFINITY;
  let stockValue = 0;
  for (const input of recipe.inputs) stockValue += (firm.inventory[input.good] ?? 0) * (prices[input.good] ?? 0);
  return (firm.cash + stockValue) / perRun;
}

/**
 * Фактические запуски: не больше плана, имеющихся входов и того, на что хватает денег на зарплату.
 * lost — сколько запусков плана не состоялось из-за каждого ограничения (input.<товар>, cash); Σ lost = план − запуски.
 */
export function feasibleRunsBreakdown(firm: Firm, recipe: Recipe, planned: number, wage: number): { runs: number; lost: Breakdown } {
  const lost: Breakdown = {};
  let runs = Math.max(0, planned);
  const limit = (ref: string, max: number) => {
    const capped = Math.max(0, max);
    if (capped < runs) {
      lost[ref] = (lost[ref] ?? 0) + runs - capped;
      runs = capped;
    }
  };
  for (const input of recipe.inputs) limit(`input.${input.good}`, (firm.inventory[input.good] ?? 0) / input.amount);
  const wagePerRun = recipe.labor * wage;
  if (wagePerRun > 0) limit('cash', firm.cash / wagePerRun);
  return { runs, lost };
}

export function feasibleRuns(firm: Firm, recipe: Recipe, planned: number, wage: number): number {
  return feasibleRunsBreakdown(firm, recipe, planned, wage).runs;
}

/**
 * Реакция на убыток: если чистая выручка за единицу (цена после налога + субсидия) ниже себестоимости,
 * выпуск урезается: × (1 − lossOutputCut × (себестоимость − выручка) / себестоимость).
 */
export function lossOutputFactor(netPrice: number, unitCost: number, firms: Balance['firms']): number {
  if (unitCost <= 0 || netPrice >= unitCost) return 1;
  return clamp(1 - (firms.lossOutputCut * (unitCost - netPrice)) / unitCost, 0, 1);
}
