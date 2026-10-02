// Стартовое состояние из сценария. Цены считаются снизу вверх по цепочке (себестоимость + стартовая наценка),
// заказы — сверху вниз от спроса домохозяйств, так что экономика стартует близко к равновесию.

import type { GameData } from '../data/load';
import type { Recipe, Scenario } from '../data/schemas';
import type { Breakdown } from './causes';
import { emptyQueue } from './delay';
import type { Firm, GoodId, MarketGood, Metrics, Province, WorldState } from './state';
import { spendingShare } from './systems/demand';
import { costPerRun } from './systems/production';
import { COMPONENT, unitCostBreakdown } from './systems/pricing';
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

export function createInitialState(data: GameData, scenario: Scenario): WorldState {
  const { balance } = data;
  const wage = scenario.wage;
  const m0 = balance.firms.initialMarkup;

  // Фирмы.
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
        price: 0,
        breakdown: {},
        markup: m0,
        ordersHistory: [],
        lastRuns: 0,
        lastSales: 0,
        lastProfit: 0,
        lossTurns: 0,
      });
    }
  }

  // Цены снизу вверх.
  const order = topologicalGoods(Object.keys(balance.demand.goods), recipeByGood);
  const prices: Record<GoodId, number> = {};
  const market: Record<GoodId, MarketGood> = {};
  for (const good of order) {
    const recipe = recipeByGood.get(good)!;
    const cost = unitCostBreakdown(recipe, prices, wage);
    let c = 0;
    for (const v of Object.values(cost)) c += v;
    const breakdown: Breakdown = { ...cost, [COMPONENT.markup]: c * m0, [COMPONENT.expectations]: 0 };
    const price = c * (1 + m0);
    prices[good] = price;
    market[good] = { price, breakdown, referencePrice: price };
  }

  // Заказы сверху вниз: спрос домохозяйств → нужды звеньев выше по цепочке.
  const population = scenario.provinces.reduce((sum, p) => sum + p.population, 0);
  const need: Record<GoodId, number> = {};
  for (const [good, params] of Object.entries(balance.demand.goods)) need[good] = params.basePerCapita * population;
  const outputByGood: Record<GoodId, number> = {};
  for (const good of [...order].reverse()) {
    const recipe = recipeByGood.get(good)!;
    const capacityOutput = firms
      .filter((f) => f.recipe === recipe.id)
      .reduce((sum, f) => sum + f.capacity * recipe.output.amount, 0);
    const output = Math.min(need[good] ?? 0, capacityOutput);
    outputByGood[good] = output;
    const runs = output / recipe.output.amount;
    for (const input of recipe.inputs) need[input.good] = (need[input.good] ?? 0) + runs * input.amount;
  }

  let laborDemand = 0;
  for (const firm of firms) {
    const recipe = data.recipes.find((r) => r.id === firm.recipe)!;
    const good = recipe.output.good;
    const sameRecipe = firms.filter((f) => f.recipe === recipe.id);
    const totalCapacity = sameRecipe.reduce((sum, f) => sum + f.capacity, 0);
    const orders = ((outputByGood[good] ?? 0) * firm.capacity) / totalCapacity;
    const runs = orders / recipe.output.amount;
    laborDemand += runs * recipe.labor;
    firm.ordersHistory = Array.from({ length: balance.firms.salesAverageTurns }, () => orders);
    firm.inventory = { [good]: balance.firms.targetCoverage * orders };
    firm.cash = balance.firms.cashBufferTurns * runs * costPerRun(recipe, prices, wage);
    firm.price = prices[good] ?? 0;
    firm.breakdown = { ...market[good]!.breakdown };
    firm.lastRuns = runs;
    firm.lastSales = orders;
  }

  // Домохозяйства: сбережения такие, чтобы s × (сбережения + зарплата) ≈ стартовые траты.
  const s = spendingShare(scenario.keyRate, balance.demand);
  if (s <= 0) throw new Error('при стартовой ставке домохозяйства ничего не тратят');
  const laborForce = scenario.provinces.reduce((sum, p) => sum + p.laborForce, 0);
  const employment = Math.min(laborDemand, laborForce);
  let spendingPerCapita = 0;
  for (const [good, params] of Object.entries(balance.demand.goods)) {
    spendingPerCapita += (prices[good] ?? 0) * params.basePerCapita;
  }
  const provinces: Province[] = scenario.provinces.map((p) => {
    const wageIncome = (employment * wage * p.laborForce) / laborForce;
    const spending = spendingPerCapita * p.population;
    return {
      id: p.id,
      nameKey: p.nameKey,
      households: {
        population: p.population,
        laborForce: p.laborForce,
        cash: Math.max(0, spending / s - wageIncome),
      },
    };
  });

  const monthlyTarget = annualToMonthly(balance.expectations.inflationTarget);
  const zeroByGood = () => Object.fromEntries(order.map((g) => [g, 0]));
  const metrics: Metrics = {
    cpi: 100,
    inflationMoM: 0,
    inflationYoY: null,
    unemployment: 1 - employment / laborForce,
    employment,
    wage,
    realWage: wage,
    householdSpending: spendingPerCapita * population,
    output: { ...outputByGood },
    householdDemand: zeroByGood(),
    householdPurchases: zeroByGood(),
    shortage: zeroByGood(),
  };

  return {
    turn: 0,
    wage,
    keyRate: scenario.keyRate,
    demandRate: scenario.keyRate,
    referenceSpendingPerCapita: spendingPerCapita,
    provinces,
    firms,
    market,
    government: { cash: 0 },
    expectations: { adaptive: monthlyTarget, expected: monthlyTarget, trust: scenario.trust },
    pending: emptyQueue(),
    cpiHistory: [100],
    metrics,
  };
}
