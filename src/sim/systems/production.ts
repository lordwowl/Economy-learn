// Производство (GDD 5.3): план от ожидаемых заказов и покрытия, выпуск ограничен мощностью, входами, трудом, деньгами.

import type { Balance, Recipe } from '../../data/schemas';
import type { Firm, GoodId } from '../state';
import { mean } from '../units';

/** Покрытие = запас / средние заказы, ограничено сверху coverageCap. */
export function coverage(stock: number, averageOrders: number, firms: Balance['firms']): number {
  if (averageOrders > 0) return Math.min(firms.coverageCap, stock / averageOrders);
  return stock > 0 ? firms.coverageCap : firms.targetCoverage;
}

/** План выпуска в запусках рецепта: ожидаемые_продажи × (1 + k × (целевое_покрытие − покрытие)), не больше мощности. */
export function plannedRuns(firm: Firm, recipe: Recipe, firms: Balance['firms']): number {
  const expectedSales = mean(firm.ordersHistory);
  const stock = firm.inventory[recipe.output.good] ?? 0;
  const cov = coverage(stock, expectedSales, firms);
  const planOutput = Math.max(0, expectedSales * (1 + firms.inventoryAdjustSpeed * (firms.targetCoverage - cov)));
  return Math.min(firm.capacity, planOutput / recipe.output.amount);
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

/** Фактические запуски: не больше плана, имеющихся входов и того, на что хватает денег на зарплату. */
export function feasibleRuns(firm: Firm, recipe: Recipe, planned: number, wage: number): number {
  let runs = planned;
  for (const input of recipe.inputs) runs = Math.min(runs, (firm.inventory[input.good] ?? 0) / input.amount);
  const wagePerRun = recipe.labor * wage;
  if (wagePerRun > 0) runs = Math.min(runs, firm.cash / wagePerRun);
  return Math.max(0, runs);
}
