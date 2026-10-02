// Кредит и инвестиции (GDD 5.8): оборотный кредит, проценты, погашение, вход новых фирм и закрытие убыточных.
// Кредит создаёт деньги вместе с долгом, погашение уничтожает; списанный долг учитывается в bank.writtenOff.

import type { Balance, ProducerBuilding, Recipe } from '../../data/schemas';
import type { Firm, GoodId, Households, WorldState } from '../state';
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

/** Заёмщик: фирма или перевозчик. */
export interface Borrower {
  cash: number;
  debt: number;
}

/** Проценты за ход банку. Если денег не хватает, неоплаченное добавляется к долгу. Возвращает начисленные проценты. */
export function chargeInterest(firm: Borrower, state: WorldState, credit: Balance['credit']): number {
  const interest = firm.debt * annualToMonthly(loanRate(state, credit));
  const paid = Math.min(interest, Math.max(0, firm.cash));
  firm.cash -= paid;
  firm.debt += interest - paid;
  state.bank.cash += interest;
  return interest;
}

/** Погашение долга деньгами сверх буфера. */
export function repay(firm: Borrower, buffer: number): number {
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

/** Желаемый долг населения: (d0 − чувствительность × (ставка − нейтральная)) × месячный доход, не меньше нуля. */
export function householdTargetDebt(households: Households, rate: number, balance: Balance): number {
  const months =
    balance.credit.householdTargetDebtToMonthlyIncome -
    balance.credit.householdDebtRateSensitivity * (rate - balance.demand.neutralRate);
  return Math.max(0, months) * households.lastIncome;
}

/**
 * Потребительский кредит за ход (GDD 5.5): проценты банку (нечем — в долг), затем население закрывает долю
 * разрыва до желаемого долга — берёт кредит или гасит (не больше своих денег). Ставка для населения —
 * ставка спроса (догоняет ключевую с лагом «ставка → спрос») + спред.
 * Возвращает изменение денег населения: новый кредит − погашение − проценты.
 */
export function householdCredit(households: Households, state: WorldState, balance: Balance): number {
  const rate = state.demandRate;
  const interest = households.debt * annualToMonthly(rate + balance.credit.loanSpread);
  const paid = Math.min(interest, Math.max(0, households.cash));
  households.cash -= paid;
  households.debt += interest - paid;
  state.bank.cash += interest;

  const gap = householdTargetDebt(households, rate, balance) - households.debt;
  let change = gap * balance.credit.householdDebtAdjustSpeed;
  if (change < 0) change = -Math.min(-change, Math.max(0, households.cash));
  households.cash += change;
  households.debt += change;
  return change - paid;
}
