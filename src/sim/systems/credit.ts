// Кредит и инвестиции (GDD 5.8): оборотный кредит, проценты, погашение, вход новых фирм и закрытие убыточных.
// Кредит создаёт деньги вместе с долгом, погашение уничтожает; списанный долг учитывается в bank.writtenOff.

import type { Balance, ProducerBuilding, Recipe } from '../../data/schemas';
import type { Firm, GoodId, WorldState } from '../state';
import { annualToMonthly, MONTHS_PER_YEAR, mean } from '../units';
import { costPerRun } from './production';

/** Годовая ставка кредита фирмам: ключевая (дошедшая до кредитов) + спред. */
export function loanRate(state: WorldState, credit: Balance['credit']): number {
  return state.creditRate + credit.loanSpread;
}

/** Лимит долга: столько-то месяцев ожидаемых продаж. */
export function debtLimit(firm: Firm, credit: Balance['credit']): number {
  return credit.maxDebtToMonthlySales * mean(firm.ordersHistory) * firm.price;
}

/**
 * Оборотный кредит: если на план не хватает денег, а продавать выгодно (цена после налога выше себестоимости),
 * фирма занимает недостающее в пределах лимита. Возвращает, сколько заняла.
 */
export function borrowForPlan(
  firm: Firm,
  recipe: Recipe,
  plannedRuns: number,
  prices: Record<GoodId, number>,
  wage: number,
  salesTax: number,
  credit: Balance['credit'],
): number {
  const perRun = costPerRun(recipe, prices, wage);
  const unitCost = perRun / recipe.output.amount;
  if (firm.price * (1 - salesTax) <= unitCost) return 0;
  let stockValue = 0;
  for (const input of recipe.inputs) stockValue += (firm.inventory[input.good] ?? 0) * (prices[input.good] ?? 0);
  const shortfall = plannedRuns * perRun - firm.cash - stockValue;
  const room = debtLimit(firm, credit) - firm.debt;
  const loan = Math.max(0, Math.min(shortfall, room));
  firm.cash += loan;
  firm.debt += loan;
  return loan;
}

/** Проценты за ход банку. Если денег не хватает, неоплаченное добавляется к долгу. Возвращает начисленные проценты. */
export function chargeInterest(firm: Firm, state: WorldState, credit: Balance['credit']): number {
  const interest = firm.debt * annualToMonthly(loanRate(state, credit));
  const paid = Math.min(interest, Math.max(0, firm.cash));
  firm.cash -= paid;
  firm.debt += interest - paid;
  state.bank.cash += interest;
  return interest;
}

/** Погашение долга деньгами сверх буфера. */
export function repay(firm: Firm, buffer: number): number {
  const amount = Math.max(0, Math.min(firm.debt, firm.cash - buffer));
  firm.cash -= amount;
  firm.debt -= amount;
  return amount;
}

/**
 * Закрытие: деньги гасят долг, остаток долга банк списывает, остаток денег — владельцам.
 * Возвращает деньги, которые достаются владельцам.
 */
export function liquidate(firm: Firm, state: WorldState): number {
  const repaid = Math.min(firm.debt, Math.max(0, firm.cash));
  firm.cash -= repaid;
  firm.debt -= repaid;
  state.bank.writtenOff += firm.debt;
  firm.debt = 0;
  const left = firm.cash;
  firm.cash = 0;
  return left;
}

/** Ожидаемая годовая доходность новой фирмы: годовая прибыль при полной загрузке / стоимость стройки. */
export function entryRoi(
  building: ProducerBuilding,
  recipe: Recipe,
  price: number,
  prices: Record<GoodId, number>,
  wage: number,
  salesTax: number,
): number {
  if (building.cost <= 0) return Number.POSITIVE_INFINITY;
  const monthly = building.capacity * (recipe.output.amount * price * (1 - salesTax) - costPerRun(recipe, prices, wage));
  return (monthly * MONTHS_PER_YEAR) / building.cost;
}
