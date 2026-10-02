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
  reserve: 'reserve',
  reserveSales: 'reserveSales',
  stateCarrier: 'stateCarrier',
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
  for (const p of state.provinces) {
    const share = (amount * weight(p)) / total;
    p.households.cash += share;
    p.households.income += share;
  }
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
/** Облигации у населения: Σ по провинциям. Остальной госдолг держит банк. */
export function householdBonds(state: WorldState): number {
  return state.provinces.reduce((sum, p) => sum + p.households.bonds, 0);
}

/** Госдолг банку — единственная часть госдолга, которая создала деньги. */
export function bankHeldGovernmentDebt(state: WorldState): number {
  return state.government.debt - householdBonds(state);
}

/**
 * Конец хода (GDD 5.11): проценты по долгу держателям облигаций (население) и банку, трансферты;
 * затем дефицит закрывается займом — население покупает облигации на свои деньги (пропорционально деньгам),
 * а если денег у населения не хватает, остаток выкупает банк (деньги создаются). Профицит гасит сначала
 * долг банку (деньги уничтожаются), потом облигации населения. Банк отдаёт доходы владельцам — населению.
 * Займ, в отличие от эмиссии, не создаёт новых денег: он перекладывает сбережения населения в бюджет.
 */
export function settleBudget(state: WorldState, gdp: number, government: Balance['government']): void {
  const gov = state.government;
  const rate = annualToMonthly(governmentRate(state, gdp, government));
  const bonds = householdBonds(state);
  addSpending(state, BUDGET.interest, gov.debt * rate);
  payHouseholds(state, bonds * rate, (p) => p.households.bonds);
  state.bank.cash += (gov.debt - bonds) * rate;

  const population = state.provinces.reduce((sum, p) => sum + p.households.population, 0);
  const transfers = gov.transfersPerCapita * population;
  addSpending(state, BUDGET.transfers, transfers);
  payHouseholds(state, transfers, (p) => p.households.population);

  if (gov.cash < 0) {
    const need = -gov.cash;
    const savings = state.provinces.reduce((sum, p) => sum + Math.max(0, p.households.cash), 0);
    const fromHouseholds = Math.min(need, savings);
    for (const p of state.provinces) {
      const take = savings > 0 ? (fromHouseholds * Math.max(0, p.households.cash)) / savings : 0;
      p.households.cash -= take;
      p.households.bonds += take;
    }
    gov.debt += need;
    gov.cash = 0;
  } else if (gov.debt > 0) {
    const repay = Math.min(gov.cash, gov.debt);
    // Сначала — долг банку, затем облигации населения (деньги возвращаются держателям).
    const toHouseholds = repay - Math.min(repay, bankHeldGovernmentDebt(state));
    const held = householdBonds(state);
    for (const p of state.provinces) {
      const back = held > 0 ? (toHouseholds * p.households.bonds) / held : 0;
      p.households.bonds -= back;
      p.households.cash += back;
    }
    gov.debt -= repay;
    gov.cash -= repay;
  }

  payHouseholds(state, state.bank.cash, (p) => p.households.population);
  state.bank.cash = 0;
}
