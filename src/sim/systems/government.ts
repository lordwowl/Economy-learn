// Государство и банк (GDD 5.11): налоги, трансферты, стройка, долг.
// Все деньги только переходят между счетами; создаёт деньги только кредит (займ государства или фирмы в банке).

import type { Balance } from '../../data/schemas';
import type { Province, WorldState } from '../state';
import { annualToMonthly, MONTHS_PER_YEAR } from '../units';

export const BUDGET = {
  salesTax: 'tax.sales',
  profitTax: 'tax.profit',
  incomeTax: 'tax.income',
  stateFirms: 'stateFirms',
  transfers: 'transfers',
  construction: 'construction',
  subsidies: 'subsidies',
  interest: 'interest',
} as const;

export function addRevenue(state: WorldState, item: string, amount: number): void {
  if (amount === 0) return;
  state.government.cash += amount;
  state.government.revenue[item] = (state.government.revenue[item] ?? 0) + amount;
}

export function addSpending(state: WorldState, item: string, amount: number): void {
  if (amount === 0) return;
  state.government.cash -= amount;
  state.government.spending[item] = (state.government.spending[item] ?? 0) + amount;
}

/** Распределяет сумму между домохозяйствами провинций пропорционально весу. */
export function payHouseholds(state: WorldState, amount: number, weight: (p: Province) => number): void {
  let total = 0;
  for (const p of state.provinces) total += weight(p);
  if (total <= 0 || amount === 0) return;
  for (const p of state.provinces) p.households.cash += (amount * weight(p)) / total;
}

/** Зарплата: домохозяйства получают её за вычетом налога на доходы, налог уходит в бюджет. */
export function payWages(state: WorldState, gross: number): void {
  const tax = gross * state.government.taxes.income;
  addRevenue(state, BUDGET.incomeTax, tax);
  payHouseholds(state, gross - tax, (p) => p.households.laborForce);
}

/** Годовая ставка по госдолгу: ключевая (дошедшая до кредитов) + премия за долг относительно годового ВВП. */
export function governmentRate(state: WorldState, gdp: number, government: Balance['government']): number {
  const annualGdp = gdp * MONTHS_PER_YEAR;
  const burden = annualGdp > 0 ? state.government.debt / annualGdp : 0;
  return state.creditRate + government.debtRatePremium * burden;
}

/**
 * Конец хода: проценты по долгу (в банк), трансферты, затем дефицит закрывается займом,
 * а профицит гасит долг. Банк отдаёт свои доходы владельцам — населению.
 */
export function settleBudget(state: WorldState, gdp: number, government: Balance['government']): void {
  const gov = state.government;
  const interest = gov.debt * annualToMonthly(governmentRate(state, gdp, government));
  addSpending(state, BUDGET.interest, interest);
  state.bank.cash += interest;

  const population = state.provinces.reduce((sum, p) => sum + p.households.population, 0);
  const transfers = gov.transfersPerCapita * population;
  addSpending(state, BUDGET.transfers, transfers);
  payHouseholds(state, transfers, (p) => p.households.population);

  if (gov.cash < 0) {
    gov.debt -= gov.cash;
    gov.cash = 0;
  } else if (gov.debt > 0) {
    const repay = Math.min(gov.cash, gov.debt);
    gov.debt -= repay;
    gov.cash -= repay;
  }

  payHouseholds(state, state.bank.cash, (p) => p.households.population);
  state.bank.cash = 0;
}
