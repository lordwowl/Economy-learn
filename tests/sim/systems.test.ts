import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { sumBreakdown } from '../../src/sim/causes';
import { planHouseholdPurchases, spendingShare } from '../../src/sim/systems/demand';
import { nextWage } from '../../src/sim/systems/labor';
import { nextMarkup, nextPriceBreakdown, unitCostBreakdown } from '../../src/sim/systems/pricing';
import { coverage } from '../../src/sim/systems/production';

const { balance, recipes } = getGameData();
const bread = recipes.find((r) => r.id === 'bread')!;
const at = (price: number) => ({ price, breakdown: { markup: price } });

describe('pricing (GDD 5.4)', () => {
  it('себестоимость хлеба: мука 0.5, топливо 0.05, труд 0.3', () => {
    const c = unitCostBreakdown(bread, { flour: at(6), fuel: at(2) }, 10);
    expect(c).toEqual({ 'input.flour': 3, 'input.fuel': 0.1, wage: 3 });
  });

  it('логистика, сидящая в цене входа, выносится в отдельную компоненту', () => {
    const flour = { price: 6, breakdown: { wage: 2, markup: 1, logistics: 3 } };
    const c = unitCostBreakdown(bread, { flour, fuel: at(2) }, 10);
    expect(c['input.flour']).toBeCloseTo(0.5 * 3, 12);
    expect(c.logistics).toBeCloseTo(0.5 * 3, 12);
    expect(sumBreakdown(c)).toBeCloseTo(0.5 * 6 + 0.05 * 2 + 0.3 * 10, 12);
  });

  it('новая цена = (1−α)P + α·c(1+m)/(1−τ) + γ·π_e·P, и Σ компонент = цене', () => {
    const current = { 'input.flour': 3, 'input.fuel': 0.1, wage: 3, markup: 1.2, expectations: 0.2 };
    const P = sumBreakdown(current);
    const cost = unitCostBreakdown(bread, { flour: at(7), fuel: at(2.5) }, 11);
    const c = sumBreakdown(cost);
    const m = 0.25;
    const pi = 0.004;
    const tax = 0.1;
    const next = nextPriceBreakdown(current, cost, m, tax, pi, balance.firms);
    const { priceStickiness: a, expectedInflationPassThrough: g } = balance.firms;
    expect(sumBreakdown(next)).toBeCloseTo((1 - a) * P + (a * c * (1 + m)) / (1 - tax) + g * pi * P, 12);
  });

  it('наценка растёт при низком покрытии и падает при высоком, в пределах [min, max]', () => {
    const f = balance.firms;
    expect(nextMarkup(0.2, 0.5 * f.targetCoverage, f)).toBeGreaterThan(0.2);
    expect(nextMarkup(0.2, 2 * f.targetCoverage, f)).toBeLessThan(0.2);
    expect(nextMarkup(f.markupMax, 0, f)).toBe(f.markupMax);
    expect(nextMarkup(f.markupMin, f.coverageCap, f)).toBe(f.markupMin);
  });

  it('покрытие ограничено coverageCap', () => {
    expect(coverage(1000, 1, balance.firms)).toBe(balance.firms.coverageCap);
    expect(coverage(5, 0, balance.firms)).toBe(balance.firms.coverageCap);
    expect(coverage(0, 0, balance.firms)).toBe(balance.firms.targetCoverage);
  });
});

describe('demand (GDD 5.5)', () => {
  const market = {
    bread: { price: 10, referencePrice: 10, breakdown: {} },
    flour: { price: 6, referencePrice: 6, breakdown: {} },
    fuel: { price: 2, referencePrice: 2, breakdown: {} },
  };
  const refSpending = 10 * 1 + 6 * 0.2 + 2 * 0.5;
  const hh = {
    population: 100,
    laborForce: 60,
    cash: (refSpending * 100) / spendingShare(balance.demand.neutralRate, balance.demand),
    referenceSpendingPerCapita: refSpending,
  };

  it('при опорных цене и бюджете спрос = base × N', () => {
    const plan = planHouseholdPurchases(hh, balance.demand.neutralRate, market, balance.demand);
    expect(plan.quantities.bread).toBeCloseTo(100, 6);
  });

  it('высокая ставка → меньше доля трат', () => {
    expect(spendingShare(0.15, balance.demand)).toBeLessThan(spendingShare(0.06, balance.demand));
  });

  it('хлеб дорожает → покупают меньше, но спрос неэластичен (|ε| < 1)', () => {
    const pricier = { ...market, bread: { ...market.bread, price: 12 } };
    const q = planHouseholdPurchases({ ...hh, cash: hh.cash * 10 }, 0.06, pricier, balance.demand);
    const qRich = planHouseholdPurchases({ ...hh, cash: hh.cash * 10 }, 0.06, market, balance.demand);
    expect(q.quantities.bread!).toBeLessThan(qRich.quantities.bread!);
    expect(q.quantities.bread! / qRich.quantities.bread!).toBeGreaterThan(1 / 1.2);
  });

  it('траты не превышают бюджет, минимум хлеба оплачивается первым', () => {
    const poor = { ...hh, cash: hh.cash * 0.3 };
    const plan = planHouseholdPurchases(poor, 0.06, market, balance.demand);
    const cost = Object.entries(plan.quantities).reduce((s, [g, q]) => s + q * market[g as keyof typeof market].price, 0);
    expect(cost).toBeLessThanOrEqual(plan.budget + 1e-9);
    const minBread = balance.demand.goods.bread!.minShareOfBase * 100;
    if (plan.budget >= minBread * 10) expect(plan.quantities.bread!).toBeGreaterThanOrEqual(minBread - 1e-9);
  });
});

describe('labor (GDD 5.7)', () => {
  it('безработица ниже естественной → зарплата растёт; вклады = изменение', () => {
    const { wage, cause } = nextWage(10, 0.01, 0.003, balance.labor, 1);
    expect(wage).toBeGreaterThan(10);
    expect(cause.causes.reduce((s, c) => s + c.value, 0)).toBeCloseTo(wage - 10, 12);
  });

  it('высокая безработица и нулевые ожидания → зарплата падает', () => {
    expect(nextWage(10, 0.2, 0, balance.labor, 1).wage).toBeLessThan(10);
  });
});
