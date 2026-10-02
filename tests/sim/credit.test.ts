import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import type { Firm } from '../../src/sim/state';
import { borrowForPlan, chargeInterest, householdTargetDebt, liquidate, repay } from '../../src/sim/systems/credit';
import { nextWage } from '../../src/sim/systems/labor';
import { baseline, run, totalMoney } from './helpers';

const data = getGameData();
const { balance } = data;
const bread = data.recipes.find((r) => r.id === 'bread')!;
const prices = { flour: 6, fuel: 2 };

function firm(patch: Partial<Firm> = {}): Firm {
  return {
    id: 'f',
    building: 'bakery',
    recipe: 'bread',
    owner: 'private',
    province: 'north',
    capacity: 80,
    inventory: {},
    cash: 0,
    debt: 0,
    underConstruction: false,
    price: 10,
    breakdown: { markup: 10 },
    markup: 0.2,
    ordersHistory: [80, 80, 80],
    lastRuns: 0,
    lastSales: 0,
    lastProfit: 0,
    lossTurns: 0,
    ...patch,
  };
}

describe('кредит (GDD 5.8)', () => {
  it('выгодный план без денег → оборотный кредит, не больше лимита', () => {
    const f = firm();
    const loan = borrowForPlan(f, bread, 80, prices, 10, 0.1, balance.credit);
    expect(loan).toBeGreaterThan(0);
    expect(f.debt).toBe(loan);
    expect(f.cash).toBe(loan);
    expect(f.debt).toBeLessThanOrEqual(balance.credit.maxDebtToMonthlySales * 80 * 10 + 1e-9);
  });

  it('невыгодно (цена ниже себестоимости) → не занимает', () => {
    expect(borrowForPlan(firm({ price: 3 }), bread, 80, prices, 10, 0.1, balance.credit)).toBe(0);
  });

  it('проценты: нечем платить → добавляются к долгу; деньги − долги сохраняются', () => {
    const state = baseline();
    const f = firm({ debt: 1000, cash: 0 });
    const interest = chargeInterest(f, state, balance.credit);
    expect(interest).toBeGreaterThan(0);
    expect(f.debt).toBeCloseTo(1000 + interest, 9);
    expect(state.bank.cash).toBeCloseTo(interest, 9);
  });

  it('погашение — только деньгами сверх буфера', () => {
    const f = firm({ debt: 500, cash: 300 });
    expect(repay(f, 100)).toBe(200);
    expect(f.debt).toBe(300);
    expect(f.cash).toBe(100);
  });

  it('закрытие: деньги гасят долг, остаток долга списывается банком', () => {
    const state = baseline();
    const f = firm({ debt: 700, cash: 200 });
    expect(liquidate(f, state)).toBe(0);
    expect(state.bank.writtenOff).toBe(500);
    expect(f.debt).toBe(0);
  });
});

describe('кредит населению (GDD 5.5)', () => {
  const hh = { population: 100, laborForce: 60, cash: 0, referenceSpendingPerCapita: 1, debt: 0, income: 0, lastIncome: 1000 };

  it('желаемый долг = d0 × доход при нейтральной ставке и меньше при высокой', () => {
    expect(householdTargetDebt(hh, balance.demand.neutralRate, balance)).toBeCloseTo(
      balance.credit.householdTargetDebtToMonthlyIncome * 1000,
      9,
    );
    expect(householdTargetDebt(hh, balance.demand.neutralRate + 0.05, balance)).toBeLessThan(
      householdTargetDebt(hh, balance.demand.neutralRate, balance),
    );
    expect(householdTargetDebt(hh, 10, balance)).toBe(0);
  });

  it('ставка ↑ → население гасит кредиты (через лаг спроса), долг ниже, чем без повышения', () => {
    const passive = run(12);
    const hike = run(12, (t) => (t === 3 ? [{ type: 'setKeyRate', rate: 0.12 }] : []));
    const debt = (s: (typeof passive.states)[number]) => s.provinces.reduce((a, p) => a + p.households.debt, 0);
    expect(debt(hike.states[4]!)).toBeCloseTo(debt(passive.states[4]!), 6);
    expect(debt(hike.states[8]!)).toBeLessThan(debt(passive.states[8]!));
  });
});

describe('зарплаты липкие вниз (GDD 5.7)', () => {
  it('при огромной безработице падают не быстрее maxMonthlyWageCut, вклады сходятся', () => {
    const { wage, cause } = nextWage(10, 0.6, 0, balance.labor, 1);
    expect(wage).toBeCloseTo(10 * (1 - balance.labor.maxMonthlyWageCut), 12);
    expect(cause.causes.some((c) => c.ref === 'labor.stickyWages')).toBe(true);
    expect(cause.causes.reduce((a, c) => a + c.value, 0)).toBeCloseTo(wage - 10, 12);
  });
});

describe('вход и выход фирм', () => {
  it('в базовом сценарии фирмы не открываются и не закрываются', () => {
    const r = run(36);
    for (const s of r.states) {
      expect(s.metrics.firmsOpened).toEqual([]);
      expect(s.metrics.firmsClosed).toEqual([]);
    }
  });

  it('не хватает мощностей пекарен на юге → в кредит строится новая пекарня, деньги − долги сохраняются', () => {
    const r = run(24, () => [], undefined, (sc) => {
      sc.firms.find((f) => f.building === 'bakery' && f.province === 'south')!.count = 1;
    });
    const opened = r.states.flatMap((s) => s.metrics.firmsOpened);
    expect(opened.some((id) => id.startsWith('bakery-south'))).toBe(true);
    const start = totalMoney(r.states[0]!);
    for (const s of r.states) expect(totalMoney(s)).toBeCloseTo(start, 6);

    const id = opened.find((x) => x.startsWith('bakery-south'))!;
    const turn = r.states.findIndex((s) => s.metrics.firmsOpened.includes(id));
    const lane = data.buildings.find((b) => b.id === 'bakery');
    if (lane?.kind !== 'producer') throw new Error('нет пекарни');
    const at = (t: number) => r.states[t]!.firms.find((f) => f.id === id)!;
    expect(at(turn).underConstruction).toBe(true);
    expect(at(turn).capacity).toBe(0);
    expect(at(turn).debt).toBeCloseTo(lane.cost, 9);
    expect(at(turn + lane.buildTurns).capacity).toBe(lane.capacity);
  });
});
