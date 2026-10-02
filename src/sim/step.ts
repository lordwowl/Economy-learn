// Один ход (= месяц) симуляции. Чистая функция: входное состояние не меняется.
//
// Порядок хода (GDD 5.16):
//  1. решения игрока и созревшие отложенные эффекты;
//  2. планы фирм (заказы, покрытие, деньги), урезка по доступному труду;
//  3. перевозчик докупает топливо; рынок входов: фирмы докупают сырьё (местное, затем привозное);
//  4. производство и выплата зарплат;
//  5. потребительский рынок (местное, затем привозное);
//  6. заказы, цены рынков провинций и страны, прибыль и дивиденды;
//  7. новые наценки и цены фирм; ИПЦ; зарплата; ожидания.

import type { GameData } from '../data/load';
import type { Recipe } from '../data/schemas';
import { breakdownChange, makeCauseEvent, sumBreakdown, type Breakdown, type CauseEvent } from './causes';
import { schedule, spreadOverLag, takeDue } from './delay';
import type { Rng } from './rng';
import type { Action, Firm, GoodId, RouteMetrics, WorldState } from './state';
import { borrowForPlan, chargeInterest, entryRoi, householdCredit, liquidate, loanRate, repay } from './systems/credit';
import { planHouseholdPurchases } from './systems/demand';
import { addRevenue, addSpending, BUDGET, payHouseholds, payWages, settleBudget } from './systems/government';
import { nextExpectations } from './systems/expectations';
import { laborScale, nextWage, unemploymentRate } from './systems/labor';
import { legKey, routeCapacity } from './systems/logistics';
import { nextMarkup, nextPriceBreakdown, unitCostBreakdown, withCeiling, withoutCeiling } from './systems/pricing';
import { affordableRuns, costPerRun, coverage, feasibleRuns, lossOutputFactor, plannedRuns } from './systems/production';
import { clearMarket } from './market';
import { freeSpace } from './systems/reserve';
import { Trade, type TradeBid } from './trade';
import { mean, MONTHS_PER_YEAR } from './units';

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
      for (const part of spreadOverLag(delta, data.balance.lags.keyRateToCredit, turn)) {
        state.pending = schedule(state.pending, part.turn, { type: 'creditRate', delta: part.delta });
      }
      break;
    }
    case 'addRoadLane': {
      const route = state.routes.find((r) => r.id === action.route);
      if (!route) throw new Error(`нет дороги "${action.route}"`);
      const lane = data.buildings.find((b) => b.kind === 'route');
      if (lane?.kind !== 'route') throw new Error('в данных нет полосы дороги');
      // Стройку оплачивает бюджет; деньги уходят строителям — населению.
      const cost = lane.costPerLength * route.length;
      addSpending(state, BUDGET.construction, cost);
      payHouseholds(state, cost, (p) => p.households.laborForce);
      state.pending = schedule(state.pending, turn + lane.buildTurns, { type: 'roadLane', route: action.route });
      break;
    }
    case 'setTax':
      state.government.taxes[action.tax] = action.rate;
      break;
    case 'setTransfers':
      state.government.transfersPerCapita = action.perCapita;
      break;
    case 'setPriceCeiling': {
      const ceilings = state.government.priceCeilings;
      if (action.price === null) delete ceilings[action.good];
      else ceilings[action.good] = action.price;
      // Потолок действует сразу: цены производителей срезаются уже в этом ходу.
      for (const firm of state.firms) {
        if (data.recipes.find((r) => r.id === firm.recipe)?.output.good !== action.good) continue;
        firm.breakdown = withCeiling(firm.breakdown, ceilings[action.good]);
        firm.price = sumBreakdown(firm.breakdown);
      }
      break;
    }
    case 'buildStorage': {
      const building = data.buildings.find((b) => b.id === action.building);
      if (building?.kind !== 'storage') throw new Error(`"${action.building}" не склад`);
      if (!state.provinces.some((p) => p.id === action.province)) throw new Error(`нет провинции "${action.province}"`);
      addSpending(state, BUDGET.construction, building.cost);
      payHouseholds(state, building.cost, (p) => p.households.laborForce);
      const id = `${building.id}-${action.province}-t${turn}`;
      state.reserve.storages.push({ id, building: building.id, province: action.province, ready: false });
      state.pending = schedule(state.pending, turn + building.buildTurns, { type: 'storageReady', storage: id });
      break;
    }
    case 'shock': {
      const shock = data.shocks.find((s) => s.id === action.shock);
      if (!shock) throw new Error(`нет шока "${action.shock}"`);
      state.activeShocks.push({ id: shock.id, until: turn + shock.turns - 1 });
      break;
    }
    case 'buildStateFleet': {
      const fleet = data.buildings.find((b) => b.kind === 'fleet');
      if (fleet?.kind !== 'fleet') throw new Error('в данных нет автопарка');
      addSpending(state, BUDGET.construction, fleet.cost);
      payHouseholds(state, fleet.cost, (p) => p.households.laborForce);
      state.logistics.carriers.find((c) => c.id === 'state')!.fleetOrdered += 1;
      state.pending = schedule(state.pending, turn + fleet.buildTurns, { type: 'fleetReady', carrier: 'state' });
      break;
    }
    case 'reserveBuy':
    case 'reserveRelease':
      // Исполняются в торговле этого хода (см. step).
      if (!state.provinces.some((p) => p.id === action.province)) throw new Error(`нет провинции "${action.province}"`);
      if (!(action.good in state.market)) throw new Error(`нет товара "${action.good}"`);
      break;
    case 'setSubsidy': {
      const g = state.government;
      const delta = action.perUnit - (g.announcedSubsidies[action.good] ?? 0);
      g.announcedSubsidies[action.good] = action.perUnit;
      for (const part of spreadOverLag(delta, data.balance.lags.subsidyToPrice, turn)) {
        state.pending = schedule(state.pending, part.turn, { type: 'subsidy', good: action.good, delta: part.delta });
      }
      break;
    }
  }
}

/** Средняя по стране цена: провинции взвешены по населению. */
function nationalAverage(state: WorldState, good: GoodId): { price: number; breakdown: Breakdown } {
  const market = state.market[good]!;
  let weight = 0;
  const breakdown: Breakdown = {};
  for (const p of state.provinces) {
    const pm = market.provinces[p.id];
    if (!pm) continue;
    const w = p.households.population;
    weight += w;
    for (const [ref, v] of Object.entries(pm.breakdown)) breakdown[ref] = (breakdown[ref] ?? 0) + w * v;
  }
  for (const ref of Object.keys(breakdown)) breakdown[ref] = breakdown[ref]! / weight;
  return { price: sumBreakdown(breakdown), breakdown };
}

export function step(prev: WorldState, actions: readonly Action[], rng: Rng, data: GameData): StepResult {
  void rng; // Случайных событий пока нет; шоки появятся вместе с уровнями.
  const state = structuredClone(prev);
  const turn = prev.turn + 1;
  const { balance } = data;
  const causes: CauseEvent[] = [];
  const recipes = new Map(data.recipes.map((r) => [r.id, r]));
  const recipeOf = (firm: Firm): Recipe => recipes.get(firm.recipe)!;
  const outputOf = (firm: Firm): GoodId => recipeOf(firm).output.good;

  // 1. Решения и отложенные эффекты.
  state.government.revenue = {};
  state.government.spending = {};
  for (const p of state.provinces) {
    p.households.lastIncome = p.households.income;
    p.households.income = 0;
  }
  for (const action of actions) applyAction(state, action, turn, data);
  state.activeShocks = state.activeShocks.filter((s) => s.until >= turn);
  const { due, queue } = takeDue(state.pending, turn);
  state.pending = queue;
  for (const effect of due) {
    if (effect.type === 'demandRate') state.demandRate += effect.delta;
    if (effect.type === 'creditRate') state.creditRate += effect.delta;
    if (effect.type === 'subsidy') {
      const subsidies = state.government.subsidies;
      subsidies[effect.good] = (subsidies[effect.good] ?? 0) + effect.delta;
    }
    if (effect.type === 'roadLane') state.routes.find((r) => r.id === effect.route)!.lanes += 1;
    if (effect.type === 'fleetReady') {
      const carrier = state.logistics.carriers.find((c) => c.id === effect.carrier)!;
      carrier.fleet += 1;
      carrier.fleetOrdered -= 1;
    }
    if (effect.type === 'storageReady') {
      const storage = state.reserve.storages.find((s) => s.id === effect.storage);
      if (storage) storage.ready = true;
    }
    if (effect.type === 'firmReady') {
      const firm = state.firms.find((f) => f.id === effect.firm);
      if (firm) {
        firm.capacity = effect.capacity;
        firm.underConstruction = false;
      }
    }
  }

  const localPrices = (province: string): Record<GoodId, number> => {
    const prices: Record<GoodId, number> = {};
    for (const [good, m] of Object.entries(state.market)) prices[good] = m.provinces[province]?.price ?? m.price;
    return prices;
  };

  /** Модификатор шока (GDD 5.3): произведение множителей мощности действующих шоков для здания фирмы. */
  const shockMultiplier = (firm: Firm): number => {
    let m = 1;
    for (const active of state.activeShocks) {
      for (const effect of data.shocks.find((s) => s.id === active.id)?.effects ?? []) {
        if (effect.building === firm.building && (effect.province === undefined || effect.province === firm.province)) {
          m *= effect.multiplier;
        }
      }
    }
    return m;
  };

  // 2. Планы; не хватает денег на выгодный план — оборотный кредит.  Шок урезает доступную мощность.
  const plan = new Map<string, number>();
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const prices = localPrices(firm.province);
    const unitCost = costPerRun(recipe, prices, state.wage) / recipe.output.amount;
    const netPrice =
      firm.price * (1 - state.government.taxes.sales) + (state.government.subsidies[recipe.output.good] ?? 0);
    const planned = Math.min(
      plannedRuns(firm, recipe, balance.firms) * lossOutputFactor(netPrice, unitCost, balance.firms),
      firm.capacity * shockMultiplier(firm),
    );
    if (planned > affordableRuns(firm, recipe, prices, state.wage)) {
      borrowForPlan(firm, recipe, planned, prices, state.wage, state.government.taxes.sales, balance.credit);
    }
    plan.set(firm.id, Math.min(planned, affordableRuns(firm, recipe, prices, state.wage)));
  }
  // Труда на всех не хватает → фабрики и перевозчик (по его загрузке прошлого хода) урезаются в одной пропорции.
  const laborForce = state.provinces.reduce((sum, p) => sum + p.households.laborForce, 0);
  let firmLabor = 0;
  for (const firm of state.firms) firmLabor += (plan.get(firm.id) ?? 0) * recipeOf(firm).labor;
  const carrierLabor = state.logistics.carriers.reduce((s, c) => s + c.lastLabor, 0);
  const scale = laborScale(firmLabor + carrierLabor, laborForce);
  for (const [id, runs] of plan) plan.set(id, runs * scale);
  const laborRequired = firmLabor * scale;

  // 3. Топливо перевозчика и рынок входов.
  const trade = new Trade(state, data, recipeOf, laborForce - laborRequired);
  // Интервенции из резерва: по текущей цене провинции, но не выше потолка.
  for (const action of actions) {
    if (action.type !== 'reserveRelease') continue;
    const stock = state.reserve.stock[action.province]?.[action.good] ?? 0;
    const market = state.market[action.good]!;
    const price = Math.min(market.provinces[action.province]?.price ?? market.price, state.government.priceCeilings[action.good] ?? Infinity);
    trade.offerFromReserve(action.good, action.province, Math.min(Math.max(0, action.quantity), stock), price);
  }
  // Топливо перевозчиков: ожидаемая работа всех перевозчиков делится между ними в порядке выбора
  // (дешёвые первыми) в пределах парка — так новый госпарк сразу заправляется под свою долю.
  const logisticsCfg = balance.logistics;
  const fleetUnit = data.buildings.find((b) => b.kind === 'fleet');
  let expectedWork = state.logistics.carriers.reduce((s, c) => s + mean(c.workHistory), 0);
  for (const carrier of [...state.logistics.carriers].sort((a, b) => a.markup - b.markup || a.id.localeCompare(b.id))) {
    const capacity = fleetUnit?.kind === 'fleet' ? carrier.fleet * fleetUnit.workCapacity : 0;
    const mine = Math.min(capacity, expectedWork);
    expectedWork -= mine;
    const fuelTarget = mine * logisticsCfg.fuelPerUnitLength * (1 + balance.firms.targetCoverage);
    trade.buyCarrierFuel(carrier, fuelTarget - carrier.fuel);
  }

  const firmById = new Map(state.firms.map((f) => [f.id, f]));
  const inputBids = new Map<GoodId, TradeBid[]>();
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const prices = localPrices(firm.province);
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
      bids.push({ buyer: firm.id, province: firm.province, quantity: n.quantity, budget: budget * share });
      inputBids.set(n.good, bids);
    }
  }
  const inputOutcomes = trade.tradePhase('inputs', inputBids);
  for (const [good, bids] of inputBids) {
    const result = inputOutcomes.get(good)!;
    for (const bid of bids) {
      const firm = firmById.get(bid.buyer)!;
      firm.inventory[good] = (firm.inventory[good] ?? 0) + (result.bought.get(bid.buyer) ?? 0);
      const paid = result.paid.get(bid.buyer) ?? 0;
      firm.cash -= paid;
      trade.spent.set(firm.id, (trade.spent.get(firm.id) ?? 0) + paid);
      trade.inputSpent.set(firm.id, (trade.inputSpent.get(firm.id) ?? 0) + paid);
    }
  }

  // 4. Производство.
  const output: Record<GoodId, number> = {};
  let productionLabor = 0;
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
    trade.spent.set(firm.id, (trade.spent.get(firm.id) ?? 0) + wages);
    firm.lastRuns = runs;
    productionLabor += runs * recipe.labor;
    wageBill += wages;
  }
  // Труд, зарезервированный под планы, но не использованный, освобождается для перевозок.
  trade.laborLeft = laborForce - productionLabor - trade.logisticsLabor;
  payWages(state, wageBill);

  // 5. Потребительский рынок.
  const consumerBids = new Map<GoodId, TradeBid[]>();
  for (const province of state.provinces) {
    const markets: Record<GoodId, { price: number; referencePrice: number; breakdown: Breakdown }> = {};
    for (const [good, m] of Object.entries(state.market)) {
      const pm = m.provinces[province.id];
      if (pm) markets[good] = pm;
    }
    householdCredit(province.households, state, balance);
    const hp = planHouseholdPurchases(province.households, state.demandRate, markets, balance.demand);
    for (const [good, q] of Object.entries(hp.quantities)) {
      const bids = consumerBids.get(good) ?? [];
      bids.push({ buyer: householdId(province.id), province: province.id, quantity: q, budget: q * (markets[good]?.price ?? 0) });
      consumerBids.set(good, bids);
    }
  }
  let householdSpending = 0;
  const blackMarket: Record<GoodId, { quantity: number; price: number }> = {};
  /**
   * Чёрный рынок провинции: долю неудовлетворённого спроса население докупает у придержавших товар фирм
   * по P_bm = потолок × (1 + k × дефицит). Возвращает, сколько куплено.
   */
  const blackMarketSales = (good: GoodId, result: { demandedByProvince: Record<string, number>; unmetByProvince: Record<string, number> }): number => {
    const ceiling = ceilings[good];
    if (ceiling === undefined) return 0;
    let total = 0;
    let value = 0;
    for (const province of state.provinces) {
      const demanded = result.demandedByProvince[province.id] ?? 0;
      const unmet = result.unmetByProvince[province.id] ?? 0;
      const sellers = state.firms.filter((f) => f.province === province.id && (heldBack.get(f.id) ?? 0) > 0 && outputOf(f) === good);
      if (demanded <= 0 || unmet <= 0 || sellers.length === 0) continue;
      const price = ceiling * (1 + balance.priceCeiling.blackMarketPremiumPerShortage * (unmet / demanded));
      const want = unmet * balance.priceCeiling.blackMarketShareOfUnmet;
      const buyer = householdId(province.id);
      const r = clearMarket(
        sellers.map((f) => ({ seller: f.id, price, quantity: heldBack.get(f.id) ?? 0 })),
        [{ buyer, quantity: want, budget: Math.min(Math.max(0, province.households.cash), want * price) }],
      );
      for (const f of sellers) {
        const q = r.sold.get(f.id) ?? 0;
        trade.sellBlack(f, good, q, province.id, price);
        heldBack.set(f.id, (heldBack.get(f.id) ?? 0) - q);
      }
      const paid = r.paid.get(buyer) ?? 0;
      province.households.cash -= paid;
      householdSpending += paid;
      total += r.quantity;
      value += paid;
    }
    if (total > 0) blackMarket[good] = { quantity: total, price: value / total };
    return total;
  };
  const householdDemand: Record<GoodId, number> = {};
  const householdPurchases: Record<GoodId, number> = {};
  const shortage: Record<GoodId, number> = {};
  const provinceShortage: Record<string, Record<GoodId, number>> = {};
  for (const p of state.provinces) provinceShortage[p.id] = {};
  // Закупки в резерв: государство — покупатель на рынке провинции, не больше свободного места.
  const reserveBuyer = (province: string) => `reserve.${province}`;
  for (const action of actions) {
    if (action.type !== 'reserveBuy') continue;
    const room = freeSpace(state.reserve, data.buildings, action.province, action.good);
    const quantity = Math.min(Math.max(0, action.quantity), room);
    if (quantity <= 0) continue;
    const bids = consumerBids.get(action.good) ?? [];
    bids.push({ buyer: reserveBuyer(action.province), province: action.province, quantity, budget: Infinity });
    consumerBids.set(action.good, bids);
  }

  // Под потолком фирмы придерживают часть склада для чёрного рынка — тем больше, чем сильнее был дефицит.
  const ceilings = state.government.priceCeilings;
  const heldBack = new Map<string, number>();
  for (const firm of state.firms) {
    const good = outputOf(firm);
    if (ceilings[good] === undefined) continue;
    const lastShortage = prev.metrics.provinceShortage[firm.province]?.[good] ?? 0;
    const q = (firm.inventory[good] ?? 0) * balance.priceCeiling.blackMarketShareOfUnmet * lastShortage;
    if (q <= 0) continue;
    firm.inventory[good] = (firm.inventory[good] ?? 0) - q;
    heldBack.set(firm.id, q);
  }

  const consumerOutcomes = trade.tradePhase('consumer', consumerBids);
  for (const good of Object.keys(balance.demand.goods)) {
    const result = consumerOutcomes.get(good);
    if (!result) continue;
    let demanded = 0;
    let unmet = 0;
    let purchased = 0;
    for (const province of state.provinces) {
      const id = householdId(province.id);
      const paid = result.paid.get(id) ?? 0;
      province.households.cash -= paid;
      householdSpending += paid;
      purchased += result.bought.get(id) ?? 0;
      const d = result.demandedByProvince[province.id] ?? 0;
      const u = result.unmetByProvince[province.id] ?? 0;
      demanded += d;
      unmet += u;
      provinceShortage[province.id]![good] = d > 0 ? u / d : 0;
    }
    householdDemand[good] = demanded;
    householdPurchases[good] = purchased + blackMarketSales(good, result);
    shortage[good] = demanded > 0 ? unmet / demanded : 0;
  }
  for (const action of actions) {
    if (action.type !== 'reserveBuy') continue;
    const outcome = consumerOutcomes.get(action.good);
    const buyer = reserveBuyer(action.province);
    const got = outcome?.bought.get(buyer) ?? 0;
    if (got <= 0) continue;
    const stock = (state.reserve.stock[action.province] ??= {});
    stock[action.good] = (stock[action.good] ?? 0) + got;
    addSpending(state, BUDGET.reserve, outcome?.paid.get(buyer) ?? 0);
    outcome?.bought.delete(buyer);
  }
  for (const firm of state.firms) {
    const q = heldBack.get(firm.id) ?? 0;
    if (q > 0) firm.inventory[outputOf(firm)] = (firm.inventory[outputOf(firm)] ?? 0) + q;
  }
  payWages(state, trade.logisticsWages);
  const employment = productionLabor + trade.logisticsLabor;
  const employmentBySector: Record<string, number> = { logistics: trade.logisticsLabor };
  for (const firm of state.firms) {
    employmentBySector[firm.building] = (employmentBySector[firm.building] ?? 0) + firm.lastRuns * recipeOf(firm).labor;
  }

  // 6a. Заказы: продажи + неудовлетворённый спрос, разнесённый по производителям пропорционально мощности.
  const capacityByGood: Record<GoodId, number> = {};
  for (const firm of state.firms) capacityByGood[outputOf(firm)] = (capacityByGood[outputOf(firm)] ?? 0) + firm.capacity;
  for (const firm of state.firms) {
    const good = outputOf(firm);
    const totalCapacity = capacityByGood[good] ?? 0;
    const unmetShare = totalCapacity > 0 ? ((trade.unmetByGood[good] ?? 0) * firm.capacity) / totalCapacity : 0;
    const sold = trade.soldByFirm.get(firm.id) ?? 0;
    firm.lastSales = sold;
    firm.ordersHistory = [...firm.ordersHistory, sold + unmetShare].slice(-balance.firms.salesAverageTurns);
  }
  for (const carrier of state.logistics.carriers) {
    const t = trade.carriers[carrier.id];
    carrier.workHistory = [...carrier.workHistory, t.requestedWork].slice(-balance.firms.salesAverageTurns);
    carrier.lastWork = t.work;
    carrier.lastLabor = t.labor;
    carrier.lastRevenue = t.revenue;
  }
  state.logistics.requested = trade.requested;

  // 6b. Цены рынков: средняя цена сделок в провинции (с доставкой), затем средняя по стране.
  for (const [good, m] of Object.entries(state.market)) {
    for (const [province, tally] of Object.entries(trade.tallies[good] ?? {})) {
      const pm = m.provinces[province];
      if (!pm || tally.quantity <= 0) continue;
      const breakdown: Breakdown = {};
      for (const [ref, v] of Object.entries(tally.weighted)) breakdown[ref] = v / tally.quantity;
      causes.push(breakdownChange(turn, `price.${good}.${province}`, pm.breakdown, breakdown));
      pm.breakdown = breakdown;
      pm.price = sumBreakdown(breakdown);
    }
    const national = nationalAverage(state, good);
    causes.push(breakdownChange(turn, `price.${good}`, m.breakdown, national.breakdown));
    m.breakdown = national.breakdown;
    m.price = national.price;
  }

  // 6c. Проценты, прибыль, налог на прибыль, погашение долга и дивиденды (госфирмы — в бюджет).
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const interest = chargeInterest(firm, state, balance.credit);
    const profit =
      (trade.revenue.get(firm.id) ?? 0) + (trade.subsidyReceived.get(firm.id) ?? 0) - (trade.spent.get(firm.id) ?? 0) - interest;
    const profitTax = Math.max(0, profit) * state.government.taxes.profit;
    firm.cash -= profitTax;
    addRevenue(state, BUDGET.profitTax, profitTax);
    firm.lastProfit = profit - profitTax;
    firm.lossTurns = firm.lastProfit < 0 && !firm.underConstruction ? firm.lossTurns + 1 : 0;
    const expectedRuns = mean(firm.ordersHistory) / recipe.output.amount;
    const buffer = balance.firms.cashBufferTurns * expectedRuns * costPerRun(recipe, localPrices(firm.province), state.wage);
    repay(firm, buffer);
    const dividend = Math.max(0, firm.cash - buffer) * balance.firms.dividendPayoutShare;
    if (dividend <= 0) continue;
    firm.cash -= dividend;
    if (firm.owner === 'state') addRevenue(state, BUDGET.stateFirms, dividend);
    else payHouseholds(state, dividend, (p) => p.households.population);
  }
  // Перевозчики: частный платит проценты, гасит долг, платит дивиденды и расширяет парк; госперевозчик рассчитывается с бюджетом.
  const fleetBuilding = data.buildings.find((b) => b.kind === 'fleet');
  for (const carrier of state.logistics.carriers) {
    if (carrier.id === 'state') {
      if (carrier.cash >= 0) addRevenue(state, BUDGET.stateCarrier, carrier.cash);
      else addSpending(state, BUDGET.stateCarrier, -carrier.cash);
      carrier.cash = 0;
      continue;
    }
    chargeInterest(carrier, state, balance.credit);
    const fuelPrice = state.market[logisticsCfg.fuelGood]?.price ?? 0;
    const cost = mean(carrier.workHistory) * logisticsCfg.fuelPerUnitLength * fuelPrice + carrier.lastLabor * state.wage;
    const buffer = balance.firms.cashBufferTurns * cost;
    repay(carrier, buffer);
    const dividend = Math.max(0, carrier.cash - buffer) * balance.firms.dividendPayoutShare;
    if (dividend > 0) {
      carrier.cash -= dividend;
      payHouseholds(state, dividend, (p) => p.households.population);
    }
    // Расширение парка: загрузка высокая и окупаемость выше ставки кредита → +1 единица в кредит.
    if (fleetBuilding?.kind !== 'fleet' || carrier.fleetOrdered > 0) continue;
    const capacity = carrier.fleet * fleetBuilding.workCapacity;
    const utilization = capacity > 0 ? mean(carrier.workHistory) / capacity : 1;
    const revenuePerWork = carrier.lastWork > 0 ? carrier.lastRevenue / carrier.lastWork : 0;
    const monthlyProfit = fleetBuilding.workCapacity * revenuePerWork * (carrier.markup / (1 + carrier.markup));
    const roi = fleetBuilding.cost > 0 ? (monthlyProfit * MONTHS_PER_YEAR) / fleetBuilding.cost : Infinity;
    if (utilization < balance.credit.entryMinUtilization) continue;
    if (roi <= loanRate(state, balance.credit) + balance.credit.expansionRoiMargin) continue;
    carrier.debt += fleetBuilding.cost;
    carrier.fleetOrdered += 1;
    payHouseholds(state, fleetBuilding.cost, (p) => p.households.laborForce);
    state.pending = schedule(state.pending, turn + fleetBuilding.buildTurns, { type: 'fleetReady', carrier: carrier.id });
  }

  // 6d. Закрытие: частная фирма после N месяцев убытков подряд. Долг гасится остатком денег, остальное банк списывает.
  const firmsClosed: string[] = [];
  state.firms = state.firms.filter((firm) => {
    if (firm.owner !== 'private' || firm.underConstruction || firm.lossTurns < balance.firms.closeAfterLossTurns) return true;
    payHouseholds(state, liquidate(firm, state), (p) => p.households.population);
    firmsClosed.push(firm.id);
    return false;
  });

  // 6e. Вход: устойчивый дефицит в провинции + высокая наценка + окупаемость выше ставки кредита → новая фирма в кредит.
  const firmsOpened: string[] = [];
  for (const [good, m] of Object.entries(state.market)) {
    const producers = state.firms.filter((f) => outputOf(f) === good);
    for (const province of state.provinces) {
      const pm = m.provinces[province.id];
      if (!pm) continue;
      const outcomes = [inputOutcomes.get(good), consumerOutcomes.get(good)];
      const demanded = outcomes.reduce((s, o) => s + (o?.demandedByProvince[province.id] ?? 0), 0);
      const unmet = outcomes.reduce((s, o) => s + (o?.unmetByProvince[province.id] ?? 0), 0);
      pm.shortageTurns = demanded > 0 && unmet / demanded > balance.credit.entryShortageThreshold ? pm.shortageTurns + 1 : 0;
      if (pm.shortageTurns < balance.credit.entryShortageTurns) continue;
      const building = data.buildings.find(
        (b) => b.kind === 'producer' && b.owner === 'private' && recipes.get(b.recipe)?.output.good === good,
      );
      if (building?.kind !== 'producer') continue;
      const recipe = recipes.get(building.recipe)!;
      const markup = producers.length > 0 ? mean(producers.map((f) => f.markup)) : balance.firms.initialMarkup;
      if (markup < balance.credit.entryMinMarkup) continue;
      const capacity = producers.reduce((s, f) => s + f.capacity, 0);
      const utilization = capacity > 0 ? producers.reduce((s, f) => s + f.lastRuns, 0) / capacity : 1;
      if (utilization < balance.credit.entryMinUtilization) continue;
      const roi = entryRoi(building, recipe, pm.price, localPrices(province.id), state.wage, state.government.taxes.sales);
      if (roi <= loanRate(state, balance.credit) + balance.credit.expansionRoiMargin) continue;
      const template = producers.find((f) => f.province === province.id) ?? producers[0];
      const id = `${building.id}-${province.id}-t${turn}`;
      state.firms.push({
        id,
        building: building.id,
        recipe: recipe.id,
        owner: building.owner,
        province: province.id,
        capacity: 0,
        inventory: {},
        cash: 0,
        debt: building.cost,
        underConstruction: true,
        price: template?.price ?? pm.price,
        breakdown: { ...(template?.breakdown ?? pm.breakdown) },
        markup: balance.firms.initialMarkup,
        ordersHistory: [],
        lastRuns: 0,
        lastSales: 0,
        lastProfit: 0,
        lossTurns: 0,
      });
      // Стройка в кредит: деньги банка уходят строителям — населению.
      payHouseholds(state, building.cost, (p) => p.households.laborForce);
      state.pending = schedule(state.pending, turn + building.buildTurns, { type: 'firmReady', firm: id, capacity: building.capacity });
      pm.shortageTurns = 0;
      firmsOpened.push(id);
    }
  }

  // 6f. ВВП (добавленная стоимость) и бюджет: проценты, трансферты, займ или погашение долга.
  let gdp = trade.logisticsRevenue - trade.logisticsFuelCost;
  for (const firm of state.firms) gdp += (trade.revenue.get(firm.id) ?? 0) - (trade.inputSpent.get(firm.id) ?? 0);
  settleBudget(state, prev.metrics.gdp, balance.government);
  const budgetContributions: Breakdown = {};
  for (const [item, v] of Object.entries(state.government.revenue)) budgetContributions[item] = v;
  for (const [item, v] of Object.entries(state.government.spending)) budgetContributions[item] = (budgetContributions[item] ?? 0) - v;
  const budgetEvent = makeCauseEvent(turn, 'budget.balance', budgetContributions);
  causes.push(budgetEvent);

  // 7a. Наценки и цены фирм на следующий ход — по ценам входов в провинции фирмы.
  const expected = state.expectations.expected;
  for (const firm of state.firms) {
    const recipe = recipeOf(firm);
    const cov = coverage(firm.inventory[recipe.output.good] ?? 0, mean(firm.ordersHistory), balance.firms);
    firm.markup = nextMarkup(firm.markup, cov, balance.firms);
    const inputs: Record<GoodId, { price: number; breakdown: Breakdown }> = {};
    for (const input of recipe.inputs) {
      const m = state.market[input.good];
      if (m) inputs[input.good] = m.provinces[firm.province] ?? m;
    }
    const unitCost = unitCostBreakdown(recipe, inputs, state.wage);
    const own = nextPriceBreakdown(
      withoutCeiling(firm.breakdown),
      unitCost,
      firm.markup,
      state.government.taxes.sales,
      state.government.subsidies[recipe.output.good] ?? 0,
      expected,
      balance.firms,
    );
    const breakdown = withCeiling(own, state.government.priceCeilings[recipe.output.good]);
    causes.push(breakdownChange(turn, `price.firm.${firm.id}`, firm.breakdown, breakdown));
    firm.breakdown = breakdown;
    firm.price = sumBreakdown(breakdown);
  }

  // 7b'. ИЦП: цена производителей товара — средняя цена фирм, взвешенная по выпуску (без выпуска — по мощности).
  //       ИЦП = 100 × Σ w·Pp / Σ w·Pp_ref; вклад товара = 100 × w × ΔPp / Σ w·Pp_ref.
  let ppiBase = 0;
  const ppiContributions: Breakdown = {};
  for (const [good, m] of Object.entries(state.market)) {
    ppiBase += m.ppiWeight * m.producerReferencePrice;
    const producers = state.firms.filter((f) => outputOf(f) === good);
    const byOutput = producers.reduce((s, f) => s + f.lastRuns, 0);
    const weight = (f: Firm) => (byOutput > 0 ? f.lastRuns : f.capacity);
    const total = producers.reduce((s, f) => s + weight(f), 0);
    if (total <= 0) continue;
    const before = m.producerPrice;
    m.producerPrice = producers.reduce((s, f) => s + weight(f) * f.price, 0) / total;
    ppiContributions[`producerPrice.${good}`] = m.ppiWeight * (m.producerPrice - before);
  }
  for (const ref of Object.keys(ppiContributions)) ppiContributions[ref] = ppiBase > 0 ? (100 * ppiContributions[ref]!) / ppiBase : 0;
  const ppiEvent = makeCauseEvent(turn, 'ppi', ppiContributions);
  causes.push(ppiEvent);

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
  // Безработица u = 1 − E / L: вклад отрасли = −ΔE_отрасли / L.
  const unemploymentContributions: Breakdown = {};
  for (const sector of new Set([...Object.keys(employmentBySector), ...Object.keys(prev.metrics.employmentBySector)])) {
    const delta = (employmentBySector[sector] ?? 0) - (prev.metrics.employmentBySector[sector] ?? 0);
    unemploymentContributions[`employment.${sector}`] = laborForce > 0 ? -delta / laborForce : 0;
  }
  causes.push(makeCauseEvent(turn, 'unemployment', unemploymentContributions));
  const wageUpdate = nextWage(state.wage, unemployment, expected, balance.labor, turn);
  causes.push(wageUpdate.cause);
  const paidWage = state.wage;
  state.wage = wageUpdate.wage;
  const exp = nextExpectations(state.expectations.adaptive, state.expectations.trust, inflationMoM, balance.expectations);
  state.expectations.adaptive = exp.adaptive;
  state.expectations.expected = exp.expected;

  const lane = data.buildings.find((b) => b.kind === 'route');
  const routes: Record<string, RouteMetrics> = {};
  for (const route of state.routes) {
    const direction = (from: string, to: string) => ({
      from,
      to,
      flow: trade.legFlow[legKey(route.id, to)] ?? 0,
      blocked: trade.legBlocked[legKey(route.id, to)] ?? 0,
    });
    routes[route.id] = {
      capacity: lane?.kind === 'route' ? routeCapacity(route, lane.capacityPerLane) : 0,
      directions: [direction(route.a, route.b), direction(route.b, route.a)],
    };
  }

  state.metrics = {
    cpi,
    ppi: prev.metrics.ppi + ppiEvent.delta,
    inflationMoM,
    inflationYoY: yearAgo !== undefined && yearAgo > 0 ? cpi / yearAgo - 1 : null,
    unemployment,
    employment,
    employmentBySector,
    wage: paidWage,
    realWage: cpi > 0 ? (paidWage * 100) / cpi : 0,
    householdSpending,
    output,
    householdDemand,
    householdPurchases,
    shortage,
    provinceShortage,
    routes,
    logisticsWork: trade.work,
    gdp,
    budgetBalance: budgetEvent.delta,
    blackMarket,
    firmsOpened,
    firmsClosed,
  };
  state.turn = turn;
  return { state, causes };
}
