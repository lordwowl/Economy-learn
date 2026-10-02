// Один ход (= месяц) симуляции. Чистая функция: входное состояние не меняется.
//
// Порядок хода:
//  1. решения игрока и созревшие отложенные эффекты;
//  2. планы фирм (заказы, покрытие, деньги), урезка по доступному труду;
//  3. рынок входов: фирмы докупают сырьё у звеньев выше по цепочке;
//  4. производство и выплата зарплат;
//  5. потребительский рынок;
//  6. заказы, средние цены рынка, прибыль и дивиденды;
//  7. новые наценки и цены фирм; ИПЦ; зарплата; ожидания.

import type { GameData } from '../data/load';
import type { Recipe } from '../data/schemas';
import { breakdownChange, makeCauseEvent, sumBreakdown, type Breakdown, type CauseEvent } from './causes';
import { schedule, spreadOverLag, takeDue } from './delay';
import { clearMarket, type Bid, type ClearingResult, type Offer } from './market';
import type { Rng } from './rng';
import type { Action, Firm, GoodId, WorldState } from './state';
import { nextExpectations } from './systems/expectations';
import { laborScale, nextWage, unemploymentRate } from './systems/labor';
import { planHouseholdPurchases } from './systems/demand';
import { affordableRuns, costPerRun, coverage, feasibleRuns, plannedRuns } from './systems/production';
import { nextMarkup, nextPriceBreakdown, unitCostBreakdown } from './systems/pricing';
import { mean } from './units';

export interface StepResult {
  state: WorldState;
  causes: CauseEvent[];
}

const CPI_HISTORY = 13;
const householdId = (province: string) => `households.${province}`;

function applyAction(state: WorldState, action: Action, turn: number, data: GameData): void {
  switch (action.type) {
    case 'setKeyRate': {
      const delta = action.rate - state.keyRate;
      state.keyRate = action.rate;
      for (const part of spreadOverLag(delta, data.balance.lags.keyRateToDemand, turn)) {
        state.pending = schedule(state.pending, part.turn, { type: 'demandRate', delta: part.delta });
      }
      break;
    }
  }
}

/** Распределяет сумму между домохозяйствами провинций пропорционально весу. */
function payHouseholds(state: WorldState, amount: number, weight: (p: WorldState['provinces'][number]) => number): void {
  let total = 0;
  for (const p of state.provinces) total += weight(p);
  if (total <= 0 || amount === 0) return;
  for (const p of state.provinces) p.households.cash += (amount * weight(p)) / total;
}

export function step(prev: WorldState, actions: readonly Action[], rng: Rng, data: GameData): StepResult {
  void rng; // В M3 случайных событий нет; шоки появятся вместе с уровнями.
  const state = structuredClone(prev);
  const turn = prev.turn + 1;
  const { balance } = data;
  const causes: CauseEvent[] = [];
  const recipes = new Map(data.recipes.map((r) => [r.id, r]));
  const recipeOf = (firm: Firm): Recipe => recipes.get(firm.recipe)!;
  const outputOf = (firm: Firm): GoodId => recipeOf(firm).output.good;

  // 1. Решения и отложенные эффекты.
  for (const action of actions) applyAction(state, action, turn, data);
  const { due, queue } = takeDue(state.pending, turn);
  state.pending = queue;
  for (const effect of due) {
    if (effect.type === 'demandRate') state.demandRate += effect.delta;
  }

  const prices: Record<GoodId, number> = {};
  for (const [good, m] of Object.entries(state.market)) prices[good] = m.price;

  // 2. Планы.
  const plan = new Map<string, number>();
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    plan.set(firm.id, Math.min(plannedRuns(firm, recipe, balance.firms), affordableRuns(firm, recipe, prices, state.wage)));
  }
  const laborForce = state.provinces.reduce((sum, p) => sum + p.households.laborForce, 0);
  let laborRequired = 0;
  for (const firm of state.firms) laborRequired += (plan.get(firm.id) ?? 0) * recipeOf(firm).labor;
  const scale = laborScale(laborRequired, laborForce);
  for (const [id, runs] of plan) plan.set(id, runs * scale);

  const firmById = new Map(state.firms.map((f) => [f.id, f]));
  const soldByFirm = new Map<string, number>();
  const revenue = new Map<string, number>();
  const spent = new Map<string, number>();
  const unmetByGood: Record<GoodId, number> = {};
  const sales: { good: GoodId; result: ClearingResult }[] = [];
  const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);

  const offersFor = (good: GoodId): Offer[] =>
    state.firms
      .filter((f) => outputOf(f) === good)
      .map((f) => ({ seller: f.id, price: f.price, quantity: f.inventory[good] ?? 0 }));

  const settle = (good: GoodId, result: ClearingResult) => {
    for (const [seller, q] of result.sold) {
      if (q <= 0) continue;
      const firm = firmById.get(seller)!;
      firm.inventory[good] = (firm.inventory[good] ?? 0) - q;
      firm.cash += q * firm.price;
      add(soldByFirm, seller, q);
      add(revenue, seller, q * firm.price);
    }
    unmetByGood[good] = (unmetByGood[good] ?? 0) + result.unmetBySupply;
    sales.push({ good, result });
  };

  // 3. Рынок входов.
  const inputGoods = [...new Set(data.recipes.flatMap((r) => r.inputs.map((i) => i.good)))].filter((g) => g in state.market);
  const inputBids = new Map<GoodId, Bid[]>();
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const runs = plan.get(firm.id) ?? 0;
    const needs = recipe.inputs.map((input) => ({
      good: input.good,
      quantity: Math.max(0, runs * input.amount - (firm.inventory[input.good] ?? 0)),
    }));
    const needsValue = needs.reduce((sum, n) => sum + n.quantity * (prices[n.good] ?? 0), 0);
    const budget = Math.max(0, firm.cash - runs * recipe.labor * state.wage);
    for (const n of needs) {
      if (n.quantity <= 0) continue;
      const share = needsValue > 0 ? (n.quantity * (prices[n.good] ?? 0)) / needsValue : 0;
      const bids = inputBids.get(n.good) ?? [];
      bids.push({ buyer: firm.id, quantity: n.quantity, budget: budget * share });
      inputBids.set(n.good, bids);
    }
  }
  for (const good of inputGoods) {
    const bids = inputBids.get(good) ?? [];
    if (bids.length === 0) continue;
    const result = clearMarket(offersFor(good), bids);
    settle(good, result);
    for (const [buyer, q] of result.bought) {
      const firm = firmById.get(buyer)!;
      firm.inventory[good] = (firm.inventory[good] ?? 0) + q;
      const paid = result.paid.get(buyer) ?? 0;
      firm.cash -= paid;
      add(spent, buyer, paid);
    }
  }

  // 4. Производство.
  const output: Record<GoodId, number> = {};
  let employment = 0;
  let wageBill = 0;
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const runs = feasibleRuns(firm, recipe, plan.get(firm.id) ?? 0, state.wage);
    for (const input of recipe.inputs) {
      firm.inventory[input.good] = Math.max(0, (firm.inventory[input.good] ?? 0) - runs * input.amount);
    }
    const produced = runs * recipe.output.amount;
    firm.inventory[recipe.output.good] = (firm.inventory[recipe.output.good] ?? 0) + produced;
    output[recipe.output.good] = (output[recipe.output.good] ?? 0) + produced;
    const wages = runs * recipe.labor * state.wage;
    firm.cash -= wages;
    add(spent, firm.id, wages);
    firm.lastRuns = runs;
    employment += runs * recipe.labor;
    wageBill += wages;
  }
  payHouseholds(state, wageBill, (p) => p.households.laborForce);

  // 5. Потребительский рынок.
  const householdDemand: Record<GoodId, number> = {};
  const householdPurchases: Record<GoodId, number> = {};
  const shortage: Record<GoodId, number> = {};
  const consumerBids = new Map<GoodId, Bid[]>();
  for (const province of state.provinces) {
    const hp = planHouseholdPurchases(
      province.households,
      state.demandRate,
      state.market,
      state.referenceSpendingPerCapita,
      balance.demand,
    );
    for (const [good, q] of Object.entries(hp.quantities)) {
      const bids = consumerBids.get(good) ?? [];
      bids.push({ buyer: householdId(province.id), quantity: q, budget: q * (prices[good] ?? 0) });
      consumerBids.set(good, bids);
    }
  }
  let householdSpending = 0;
  for (const good of Object.keys(balance.demand.goods)) {
    const bids = consumerBids.get(good) ?? [];
    const result = clearMarket(offersFor(good), bids);
    settle(good, result);
    for (const province of state.provinces) {
      const paid = result.paid.get(householdId(province.id)) ?? 0;
      province.households.cash -= paid;
      householdSpending += paid;
    }
    householdDemand[good] = result.demanded;
    householdPurchases[good] = result.quantity;
    shortage[good] = result.demanded > 0 ? result.unmetBySupply / result.demanded : 0;
  }

  // 6a. Заказы: продажи + неудовлетворённый спрос, разнесённый по производителям пропорционально мощности.
  const capacityByGood: Record<GoodId, number> = {};
  for (const firm of state.firms) capacityByGood[outputOf(firm)] = (capacityByGood[outputOf(firm)] ?? 0) + firm.capacity;
  for (const firm of state.firms) {
    const good = outputOf(firm);
    const unmetShare = ((unmetByGood[good] ?? 0) * firm.capacity) / (capacityByGood[good] ?? 1);
    const sold = soldByFirm.get(firm.id) ?? 0;
    firm.lastSales = sold;
    firm.ordersHistory = [...firm.ordersHistory, sold + unmetShare].slice(-balance.firms.salesAverageTurns);
  }

  // 6b. Средние цены сделок и их разложение (по ценам, по которым продавали в этом ходу).
  const soldValue: Record<GoodId, { quantity: number; breakdown: Breakdown }> = {};
  for (const { good, result } of sales) {
    const acc = (soldValue[good] ??= { quantity: 0, breakdown: {} });
    for (const [seller, q] of result.sold) {
      if (q <= 0) continue;
      acc.quantity += q;
      for (const [ref, v] of Object.entries(firmById.get(seller)!.breakdown)) {
        acc.breakdown[ref] = (acc.breakdown[ref] ?? 0) + q * v;
      }
    }
  }
  for (const [good, m] of Object.entries(state.market)) {
    const acc = soldValue[good];
    if (!acc || acc.quantity <= 0) continue;
    const breakdown: Breakdown = {};
    for (const [ref, v] of Object.entries(acc.breakdown)) breakdown[ref] = v / acc.quantity;
    causes.push(breakdownChange(turn, `price.${good}`, m.breakdown, breakdown));
    m.breakdown = breakdown;
    m.price = sumBreakdown(breakdown);
    prices[good] = m.price;
  }

  // 6c. Прибыль и дивиденды; госдоходы в M3 сразу возвращаются населению трансфертами.
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    firm.lastProfit = (revenue.get(firm.id) ?? 0) - (spent.get(firm.id) ?? 0);
    firm.lossTurns = firm.lastProfit < 0 ? firm.lossTurns + 1 : 0;
    const expectedRuns = mean(firm.ordersHistory) / recipe.output.amount;
    const buffer = balance.firms.cashBufferTurns * expectedRuns * costPerRun(recipe, prices, state.wage);
    const dividend = Math.max(0, firm.cash - buffer) * balance.firms.dividendPayoutShare;
    if (dividend <= 0) continue;
    firm.cash -= dividend;
    if (firm.owner === 'state') state.government.cash += dividend;
    else payHouseholds(state, dividend, (p) => p.households.population);
  }
  payHouseholds(state, state.government.cash, (p) => p.households.population);
  state.government.cash = 0;

  // 7a. Наценки и цены фирм на следующий ход.
  const expected = state.expectations.expected;
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const cov = coverage(firm.inventory[recipe.output.good] ?? 0, mean(firm.ordersHistory), balance.firms);
    firm.markup = nextMarkup(firm.markup, cov, balance.firms);
    const unitCost = unitCostBreakdown(recipe, prices, state.wage);
    const breakdown = nextPriceBreakdown(firm.breakdown, unitCost, firm.markup, expected, balance.firms);
    causes.push(breakdownChange(turn, `price.firm.${firm.id}`, firm.breakdown, breakdown));
    firm.breakdown = breakdown;
    firm.price = sumBreakdown(breakdown);
  }

  // 7b. ИПЦ: 100 × Σ w·P / Σ w·P_ref. Вклад товара = 100 × w × ΔP / Σ w·P_ref.
  let base = 0;
  for (const [good, w] of Object.entries(balance.cpiWeights)) base += w * (state.market[good]?.referencePrice ?? 0);
  const cpiContributions: Breakdown = {};
  for (const [good, w] of Object.entries(balance.cpiWeights)) {
    const before = prev.market[good]?.price ?? 0;
    const after = state.market[good]?.price ?? 0;
    cpiContributions[`price.${good}`] = base > 0 ? (100 * w * (after - before)) / base : 0;
  }
  const cpiEvent = makeCauseEvent(turn, 'cpi', cpiContributions);
  causes.push(cpiEvent);
  const cpi = prev.metrics.cpi + cpiEvent.delta;
  state.cpiHistory = [...state.cpiHistory, cpi].slice(-CPI_HISTORY);
  const inflationMoM = prev.metrics.cpi > 0 ? cpi / prev.metrics.cpi - 1 : 0;
  const yearAgo = state.cpiHistory.length === CPI_HISTORY ? state.cpiHistory[0] : undefined;

  // 7c. Зарплата и ожидания.
  const unemployment = unemploymentRate(employment, laborForce);
  const wageUpdate = nextWage(state.wage, unemployment, expected, balance.labor, turn);
  causes.push(wageUpdate.cause);
  const paidWage = state.wage;
  state.wage = wageUpdate.wage;
  const exp = nextExpectations(state.expectations.adaptive, state.expectations.trust, inflationMoM, balance.expectations);
  state.expectations.adaptive = exp.adaptive;
  state.expectations.expected = exp.expected;

  state.metrics = {
    cpi,
    inflationMoM,
    inflationYoY: yearAgo !== undefined && yearAgo > 0 ? cpi / yearAgo - 1 : null,
    unemployment,
    employment,
    wage: paidWage,
    realWage: cpi > 0 ? (paidWage * 100) / cpi : 0,
    householdSpending,
    output,
    householdDemand,
    householdPurchases,
    shortage,
  };
  state.turn = turn;
  return { state, causes };
}
