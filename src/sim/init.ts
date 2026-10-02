// Стартовое состояние из сценария, откалиброванное близко к равновесию:
//  1) заказы — сверху вниз от спроса домохозяйств (плюс топливо перевозчика);
//  2) потоки между провинциями — нехватка провинции покрывается остатками других по дорогам;
//  3) цены — снизу вверх по цепочке, в каждой провинции свои: местное + привозное с тарифом.

import type { GameData } from '../data/load';
import type { Recipe, Scenario } from '../data/schemas';
import type { Breakdown } from './causes';
import { emptyQueue } from './delay';
import type { Carrier, Firm, GoodId, Logistics, MarketGood, Metrics, Province, Route, RouteMetrics, WorldState } from './state';
import { householdTargetDebt } from './systems/credit';
import { spendingShare } from './systems/demand';
import {
  laborPerUnit,
  legKey,
  planShipments,
  routeCapacity,
  shortestPaths,
  tariff,
  type GoodBalance,
  type Path,
  type Shipment,
} from './systems/logistics';
import { COMPONENT, unitCostBreakdown, type InputPrice } from './systems/pricing';
import { costPerRun } from './systems/production';
import { annualToMonthly } from './units';

function recipeOf(data: GameData, buildingId: string): { recipe: Recipe; capacity: number; owner: Firm['owner'] } {
  const building = data.buildings.find((b) => b.id === buildingId);
  if (!building || building.kind !== 'producer') throw new Error(`"${buildingId}" не производственное здание`);
  const recipe = data.recipes.find((r) => r.id === building.recipe);
  if (!recipe) throw new Error(`нет рецепта "${building.recipe}"`);
  return { recipe, capacity: building.capacity, owner: building.owner };
}

/** Товары в порядке «входы раньше выходов». */
function topologicalGoods(goods: Iterable<GoodId>, recipeByGood: Map<GoodId, Recipe>): GoodId[] {
  const order: GoodId[] = [];
  const state = new Map<GoodId, 'visiting' | 'done'>();
  const visit = (good: GoodId) => {
    const mark = state.get(good);
    if (mark === 'done') return;
    if (mark === 'visiting') throw new Error(`цикл в рецептах через "${good}"`);
    const recipe = recipeByGood.get(good);
    if (!recipe) throw new Error(`товар "${good}" нужен, но его никто не производит`);
    state.set(good, 'visiting');
    for (const input of recipe.inputs) visit(input.good);
    state.set(good, 'done');
    order.push(good);
  };
  for (const good of goods) visit(good);
  return order;
}

function createFirms(data: GameData, scenario: Scenario): { firms: Firm[]; recipeByGood: Map<GoodId, Recipe> } {
  const firms: Firm[] = [];
  const counters = new Map<string, number>();
  const recipeByGood = new Map<GoodId, Recipe>();
  for (const entry of scenario.firms) {
    const { recipe, capacity, owner } = recipeOf(data, entry.building);
    const known = recipeByGood.get(recipe.output.good);
    if (known && known.id !== recipe.id) throw new Error(`товар "${recipe.output.good}" производится разными рецептами`);
    recipeByGood.set(recipe.output.good, recipe);
    for (let i = 0; i < entry.count; i++) {
      const key = `${entry.building}-${entry.province}`;
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      firms.push({
        id: `${key}-${n}`,
        building: entry.building,
        recipe: recipe.id,
        owner,
        province: entry.province,
        capacity,
        inventory: {},
        cash: 0,
        debt: 0,
        underConstruction: false,
        price: 0,
        breakdown: {},
        markup: data.balance.firms.initialMarkup,
        ordersHistory: [],
        lastRuns: 0,
        lastSales: 0,
        lastProfit: 0,
        lossTurns: 0,
      });
    }
  }
  return { firms, recipeByGood };
}

interface Plan {
  /** Запуски рецепта за ход по фирмам. */
  runs: Map<string, number>;
  output: Record<GoodId, number>;
  /** Потоки по товарам. */
  shipments: Record<GoodId, Shipment[]>;
  /** Работа перевозчика: груз × длина. */
  work: number;
  logisticsLabor: number;
  requested: Logistics['requested'];
}

export function createInitialState(data: GameData, scenario: Scenario): WorldState {
  const { balance } = data;
  const wage = scenario.wage;
  const m0 = balance.firms.initialMarkup;
  const cfg = balance.logistics;
  const salesTax = scenario.taxes.sales;
  const { firms, recipeByGood } = createFirms(data, scenario);
  const provinceIds = scenario.provinces.map((p) => p.id);
  const population = scenario.provinces.reduce((sum, p) => sum + p.population, 0);
  const recipeFor = (firm: Firm) => data.recipes.find((r) => r.id === firm.recipe)!;

  const routes: Route[] = scenario.routes.map((r) => ({ ...r }));
  const paths = shortestPaths(provinceIds, routes);
  const lane = data.buildings.find((b) => b.kind === 'route');
  const capacityPerLane = lane?.kind === 'route' ? lane.capacityPerLane : 0;

  const goods = [...(recipeByGood.has(cfg.fuelGood) ? [cfg.fuelGood] : []), ...Object.keys(balance.demand.goods)];
  const order = topologicalGoods(goods, recipeByGood);

  // 1–2. Заказы и потоки. Топливо перевозчика зависит от потоков, поэтому план считается дважды.
  const makePlan = (logisticsFuel: number): Plan => {
    const need: Record<GoodId, number> = {};
    for (const [good, params] of Object.entries(balance.demand.goods)) need[good] = params.basePerCapita * population;
    need[cfg.fuelGood] = (need[cfg.fuelGood] ?? 0) + logisticsFuel;
    const output: Record<GoodId, number> = {};
    const runs = new Map<string, number>();
    for (const good of [...order].reverse()) {
      const recipe = recipeByGood.get(good)!;
      const producers = firms.filter((f) => f.recipe === recipe.id);
      const capacity = producers.reduce((sum, f) => sum + f.capacity, 0);
      const out = Math.min(need[good] ?? 0, capacity * recipe.output.amount);
      output[good] = out;
      for (const f of producers) runs.set(f.id, ((out / recipe.output.amount) * f.capacity) / capacity);
      for (const input of recipe.inputs) need[input.good] = (need[input.good] ?? 0) + (out / recipe.output.amount) * input.amount;
    }

    const capacityLeft: Record<string, number> = {};
    for (const r of routes) for (const to of [r.a, r.b]) capacityLeft[legKey(r.id, to)] = routeCapacity(r, capacityPerLane);
    const balances: GoodBalance[] = [];
    /** Доля домохозяйств в спросе провинции на товар — чтобы разделить заявки на перевозку по фазам. */
    const householdShare: Record<GoodId, Record<string, number>> = {};
    for (const good of order) {
      const households: Record<string, number> = {};
      const demand: Record<string, number> = {};
      const supply: Record<string, number> = {};
      for (const p of scenario.provinces) {
        households[p.id] = (balance.demand.goods[good]?.basePerCapita ?? 0) * p.population;
        demand[p.id] = households[p.id]!;
      }
      for (const f of firms) {
        const recipe = recipeFor(f);
        const r = runs.get(f.id) ?? 0;
        if (recipe.output.good === good) supply[f.province] = (supply[f.province] ?? 0) + r * recipe.output.amount;
        for (const input of recipe.inputs) {
          if (input.good === good) demand[f.province] = (demand[f.province] ?? 0) + r * input.amount;
        }
      }
      const deficits: Record<string, number> = {};
      const stocks: Record<string, number> = {};
      householdShare[good] = {};
      for (const p of provinceIds) {
        const local = Math.min(demand[p] ?? 0, supply[p] ?? 0);
        deficits[p] = (demand[p] ?? 0) - local;
        stocks[p] = (supply[p] ?? 0) - local;
        householdShare[good][p] = (demand[p] ?? 0) > 0 ? (households[p] ?? 0) / demand[p]! : 0;
      }
      balances.push({ good, deficits, stocks });
    }
    const list = planShipments(balances, paths, { capacityLeft, work: Infinity, labor: Infinity }, cfg);
    const shipments: Record<GoodId, Shipment[]> = Object.fromEntries(order.map((g) => [g, []]));
    const requested: Logistics['requested'] = { inputs: {}, consumer: {} };
    let work = 0;
    let logisticsLabor = 0;
    for (const sh of list) {
      shipments[sh.good]!.push(sh);
      work += sh.quantity * sh.path.length;
      logisticsLabor += sh.quantity * laborPerUnit(sh.path, cfg);
      const hh = householdShare[sh.good]?.[sh.to] ?? 0;
      for (const e of sh.path.edges) {
        requested.consumer[e] = (requested.consumer[e] ?? 0) + sh.requested * hh;
        requested.inputs[e] = (requested.inputs[e] ?? 0) + sh.requested * (1 - hh);
      }
    }
    return { runs, output, shipments, work, logisticsLabor, requested };
  };
  const first = makePlan(0);
  const plan = makePlan(first.work * cfg.fuelPerUnitLength);

  // 3. Цены по провинциям снизу вверх.
  const producerPrice: Record<GoodId, Record<string, InputPrice>> = {};
  const marketPrice: Record<GoodId, Record<string, InputPrice>> = {};
  let fuelPrice = 0;
  // Перевозчики: госпарк из сценария берёт работу первым, частный — остальное.
  const fleetBuilding = data.buildings.find((b) => b.kind === 'fleet');
  const workPerUnit = fleetBuilding?.kind === 'fleet' ? fleetBuilding.workCapacity : 0;
  const stateWork = Math.min(plan.work, scenario.fleet.state * workPerUnit);
  const privateWork = plan.work - stateWork;
  const privateFleet =
    scenario.fleet.private === 'auto'
      ? Math.ceil(privateWork / (workPerUnit * balance.credit.entryMinUtilization))
      : scenario.fleet.private;
  const stateShare = plan.work > 0 ? stateWork / plan.work : 0;
  const tariffOf = (path: Path) =>
    stateShare * tariff(path, fuelPrice, wage, cfg, 0) + (1 - stateShare) * tariff(path, fuelPrice, wage, cfg, cfg.markup);
  for (const good of order) {
    const recipe = recipeByGood.get(good)!;
    producerPrice[good] = {};
    for (const p of provinceIds) {
      if (!firms.some((f) => f.recipe === recipe.id && f.province === p)) continue;
      const inputs: Record<GoodId, InputPrice> = {};
      for (const input of recipe.inputs) inputs[input.good] = marketPrice[input.good]![p]!;
      const cost = unitCostBreakdown(recipe, inputs, wage);
      let c = 0;
      for (const v of Object.values(cost)) c += v;
      const price = (c * (1 + m0)) / (1 - salesTax);
      producerPrice[good][p] = {
        price,
        breakdown: { ...cost, [COMPONENT.markup]: c * m0, [COMPONENT.salesTax]: salesTax * price, [COMPONENT.expectations]: 0 },
      };
    }
    // Средняя цена производителей (взвешена по выпуску) — для провинций без сделок и для тарифа.
    const average: Breakdown = {};
    let outputTotal = 0;
    for (const f of firms.filter((x) => x.recipe === recipe.id)) {
      const q = plan.runs.get(f.id) ?? 0;
      outputTotal += q;
      for (const [ref, v] of Object.entries(producerPrice[good][f.province]!.breakdown)) average[ref] = (average[ref] ?? 0) + q * v;
    }
    for (const ref of Object.keys(average)) average[ref] = outputTotal > 0 ? average[ref]! / outputTotal : 0;
    if (good === cfg.fuelGood) fuelPrice = Object.values(average).reduce((s, v) => s + v, 0);

    marketPrice[good] = {};
    for (const p of provinceIds) {
      const weighted: Breakdown = {};
      let quantity = 0;
      const addTx = (q: number, from: InputPrice, delivery: number) => {
        if (q <= 0) return;
        quantity += q;
        for (const [ref, v] of Object.entries(from.breakdown)) weighted[ref] = (weighted[ref] ?? 0) + q * v;
        if (delivery !== 0) weighted[COMPONENT.logistics] = (weighted[COMPONENT.logistics] ?? 0) + q * delivery;
      };
      const local = producerPrice[good][p];
      const supplyLocal = firms
        .filter((f) => f.recipe === recipe.id && f.province === p)
        .reduce((s, f) => s + (plan.runs.get(f.id) ?? 0) * recipe.output.amount, 0);
      const shippedOut = plan.shipments[good]!.filter((s) => s.from === p).reduce((s, x) => s + x.quantity, 0);
      if (local) addTx(supplyLocal - shippedOut, local, 0);
      for (const s of plan.shipments[good]!.filter((x) => x.to === p)) addTx(s.quantity, producerPrice[good][s.from]!, tariffOf(s.path));
      const breakdown: Breakdown = {};
      if (quantity > 0) for (const [ref, v] of Object.entries(weighted)) breakdown[ref] = v / quantity;
      else Object.assign(breakdown, local?.breakdown ?? average);
      marketPrice[good][p] = { price: Object.values(breakdown).reduce((s, v) => s + v, 0), breakdown };
    }
  }

  const market: Record<GoodId, MarketGood> = {};
  for (const good of order) {
    const national: Breakdown = {};
    for (const p of scenario.provinces) {
      for (const [ref, v] of Object.entries(marketPrice[good]![p.id]!.breakdown)) {
        national[ref] = (national[ref] ?? 0) + (v * p.population) / population;
      }
    }
    const price = Object.values(national).reduce((s, v) => s + v, 0);
    const provinces: MarketGood['provinces'] = {};
    for (const p of provinceIds) {
      const pm = marketPrice[good]![p]!;
      provinces[p] = { price: pm.price, breakdown: { ...pm.breakdown }, referencePrice: pm.price, shortageTurns: 0 };
    }
    // ИЦП: цена производителей и вес товара — по стартовому выпуску.
    const recipe = recipeByGood.get(good)!;
    let outputValue = 0;
    let outputQty = 0;
    for (const f of firms.filter((x) => x.recipe === recipe.id)) {
      const q = (plan.runs.get(f.id) ?? 0) * recipe.output.amount;
      outputQty += q;
      outputValue += q * producerPrice[good]![f.province]!.price;
    }
    const producer = outputQty > 0 ? outputValue / outputQty : price;
    market[good] = {
      price,
      breakdown: national,
      referencePrice: price,
      provinces,
      producerPrice: producer,
      producerReferencePrice: producer,
      ppiWeight: outputValue,
    };
  }

  // 4. Фирмы. Попутно — стартовые доходы бюджета (для сбалансированных трансфертов) и ВВП.
  let laborDemand = plan.logisticsLabor;
  let revenue = 0;
  let gdp = 0;
  for (const firm of firms) {
    const recipe = recipeFor(firm);
    const good = recipe.output.good;
    const runs = plan.runs.get(firm.id) ?? 0;
    const orders = runs * recipe.output.amount;
    const prices: Record<GoodId, number> = {};
    for (const g of order) prices[g] = marketPrice[g]![firm.province]!.price;
    laborDemand += runs * recipe.labor;
    const sales = orders * producerPrice[good]![firm.province]!.price;
    let inputs = 0;
    for (const input of recipe.inputs) inputs += runs * input.amount * (prices[input.good] ?? 0);
    const profit = sales * (1 - salesTax) - inputs - runs * recipe.labor * wage;
    const profitTax = Math.max(0, profit) * scenario.taxes.profit;
    revenue += sales * salesTax + profitTax + (firm.owner === 'state' ? profit - profitTax : 0);
    gdp += sales - inputs;
    firm.ordersHistory = Array.from({ length: balance.firms.salesAverageTurns }, () => orders);
    firm.inventory = { [good]: balance.firms.targetCoverage * orders };
    firm.cash = balance.firms.cashBufferTurns * runs * costPerRun(recipe, prices, wage);
    const own = producerPrice[good]![firm.province]!;
    firm.price = own.price;
    firm.breakdown = { ...own.breakdown };
    firm.lastRuns = runs;
    firm.lastSales = orders;
  }

  for (const list of Object.values(plan.shipments)) for (const sh of list) gdp += sh.quantity * tariffOf(sh.path);
  gdp -= plan.work * cfg.fuelPerUnitLength * fuelPrice;

  const carrier = (id: Carrier['id'], markup: number, work: number, fleet: number): Carrier => {
    const share = plan.work > 0 ? work / plan.work : 0;
    const labor = plan.logisticsLabor * share;
    let revenue = 0;
    for (const list of Object.values(plan.shipments)) {
      for (const sh of list) revenue += sh.quantity * share * tariff(sh.path, fuelPrice, wage, cfg, markup);
    }
    return {
      id,
      markup,
      cash: id === 'state' ? 0 : balance.firms.cashBufferTurns * (work * cfg.fuelPerUnitLength * fuelPrice + labor * wage),
      debt: 0,
      fuel: work * cfg.fuelPerUnitLength * balance.firms.targetCoverage,
      fleet,
      fleetOrdered: 0,
      workHistory: Array.from({ length: balance.firms.salesAverageTurns }, () => work),
      lastWork: work,
      lastLabor: labor,
      lastRevenue: revenue,
    };
  };

  const logistics: Logistics = {
    carriers: [
      carrier('state', 0, stateWork, scenario.fleet.state),
      carrier('private', cfg.markup, privateWork, privateFleet),
    ],
    requested: plan.requested,
  };

  // 5. Домохозяйства: сбережения такие, чтобы s × (сбережения + зарплата) ≈ стартовые траты.
  const s = spendingShare(scenario.keyRate, balance.demand);
  if (s <= 0) throw new Error('при стартовой ставке домохозяйства ничего не тратят');
  const laborForce = scenario.provinces.reduce((sum, p) => sum + p.laborForce, 0);
  const employment = Math.min(laborDemand, laborForce);
  // Занятые по отраслям; если труда не хватает, все урезаются в одной пропорции (как в ходе).
  const laborShare = laborDemand > 0 ? employment / laborDemand : 0;
  const employmentBySector: Record<string, number> = { logistics: plan.logisticsLabor * laborShare };
  for (const firm of firms) {
    employmentBySector[firm.building] =
      (employmentBySector[firm.building] ?? 0) + (plan.runs.get(firm.id) ?? 0) * recipeFor(firm).labor * laborShare;
  }
  revenue += employment * wage * scenario.taxes.income;
  const transfersPerCapita = scenario.transfersPerCapita === 'balanced' ? revenue / population : scenario.transfersPerCapita;
  const provinces: Province[] = scenario.provinces.map((p) => {
    let perCapita = 0;
    for (const [good, params] of Object.entries(balance.demand.goods)) {
      perCapita += marketPrice[good]![p.id]!.price * params.basePerCapita;
    }
    const wageIncome = (employment * wage * (1 - scenario.taxes.income) * p.laborForce) / laborForce;
    const households = {
      population: p.population,
      laborForce: p.laborForce,
      cash: Math.max(0, (perCapita * p.population) / s - wageIncome),
      referenceSpendingPerCapita: perCapita,
      debt: 0,
      bonds: 0,
      // В равновесии доходы ≈ траты; в начале первого хода income станет lastIncome.
      income: perCapita * p.population,
      lastIncome: perCapita * p.population,
    };
    // Население стартует с желаемым долгом — без рывка кредита на первом ходу.
    households.debt = householdTargetDebt(households, scenario.keyRate, balance);
    return { id: p.id, nameKey: p.nameKey, households };
  });

  const routeMetrics: Record<string, RouteMetrics> = {};
  const legFlow: Record<string, number> = {};
  for (const list of Object.values(plan.shipments)) {
    for (const sh of list) for (const e of sh.path.edges) legFlow[e] = (legFlow[e] ?? 0) + sh.quantity;
  }
  for (const r of routes) {
    const direction = (from: string, to: string) => ({ from, to, flow: legFlow[legKey(r.id, to)] ?? 0, blocked: 0 });
    routeMetrics[r.id] = { capacity: routeCapacity(r, capacityPerLane), directions: [direction(r.a, r.b), direction(r.b, r.a)] };
  }

  const monthlyTarget = annualToMonthly(balance.expectations.inflationTarget);
  const zeroByGood = () => Object.fromEntries(order.map((g) => [g, 0]));
  let spending = 0;
  for (const p of provinces) spending += p.households.referenceSpendingPerCapita * p.households.population;
  // Веса ИЦП — доли стартового выпуска по стоимости.
  const totalOutputValue = Object.values(market).reduce((s, m) => s + m.ppiWeight, 0);
  for (const m of Object.values(market)) m.ppiWeight = totalOutputValue > 0 ? m.ppiWeight / totalOutputValue : 0;
  const metrics: Metrics = {
    cpi: 100,
    ppi: 100,
    inflationMoM: 0,
    inflationYoY: null,
    unemployment: 1 - employment / laborForce,
    employmentBySector,
    employment,
    wage,
    realWage: wage,
    householdSpending: spending,
    output: { ...plan.output },
    householdDemand: zeroByGood(),
    householdPurchases: zeroByGood(),
    shortage: zeroByGood(),
    provinceShortage: Object.fromEntries(provinceIds.map((p) => [p, zeroByGood()])),
    routes: routeMetrics,
    logisticsWork: plan.work,
    gdp,
    budgetBalance: 0,
    blackMarket: {},
    firmsOpened: [],
    firmsClosed: [],
  };

  return {
    turn: 0,
    wage,
    keyRate: scenario.keyRate,
    demandRate: scenario.keyRate,
    creditRate: scenario.keyRate,
    provinces,
    routes,
    logistics,
    firms,
    market,
    government: {
      cash: 0,
      debt: 0,
      taxes: { ...scenario.taxes },
      transfersPerCapita,
      subsidies: {},
      announcedSubsidies: {},
      priceCeilings: {},
      revenue: {},
      spending: {},
    },
    bank: { cash: 0, writtenOff: 0 },
    activeShocks: [],
    reserve: {
      storages: scenario.reserve.storages.map((s, i) => ({ id: `${s.building}-${s.province}-${i + 1}`, building: s.building, province: s.province, ready: true })),
      stock: scenario.reserve.stock.reduce<Record<string, Record<GoodId, number>>>((acc, item) => {
        const byGood = (acc[item.province] ??= {});
        byGood[item.good] = (byGood[item.good] ?? 0) + item.quantity;
        return acc;
      }, {}),
    },
    expectations: { adaptive: monthlyTarget, expected: monthlyTarget, trust: scenario.trust },
    pending: emptyQueue(),
    cpiHistory: [100],
    metrics,
  };
}
