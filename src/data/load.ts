import { z } from 'zod';
import {
  balanceSchema,
  scenarioSchema,
  buildingsFileSchema,
  levelSchema,
  goodsFileSchema,
  recipesFileSchema,
  shocksFileSchema,
  type Balance,
  type Building,
  type Good,
  type Level,
  type Recipe,
  type Scenario,
  type Shock,
} from './schemas';

export interface GameData {
  balance: Balance;
  goods: Good[];
  recipes: Recipe[];
  buildings: Building[];
  shocks: Shock[];
}

export interface RawGameData {
  balance: unknown;
  goods: unknown;
  recipes: unknown;
  buildings: unknown;
  shocks: unknown;
}

export class GameDataError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Некорректные данные игры:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'GameDataError';
    this.issues = issues;
  }
}

function parseFile<T>(file: string, schema: z.ZodType<T>, raw: unknown, issues: string[]): T | undefined {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(корень)';
    issues.push(`${file}: ${path}: ${issue.message}`);
  }
  return undefined;
}

function checkUniqueIds(file: string, items: { id: string }[], issues: string[]): void {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) issues.push(`${file}: повторяющийся id "${id}"`);
    seen.add(id);
  }
}

/** Проверки ссылок между файлами: то, что не выразить схемой одного файла. */
function checkReferences(data: GameData, issues: string[]): void {
  const goodIds = new Set(data.goods.map((g) => g.id));
  const recipeIds = new Set(data.recipes.map((r) => r.id));
  const needGood = (where: string, good: string) => {
    if (!goodIds.has(good)) issues.push(`${where}: неизвестный товар "${good}"`);
  };

  checkUniqueIds('goods.json', data.goods, issues);
  checkUniqueIds('recipes.json', data.recipes, issues);
  checkUniqueIds('buildings.json', data.buildings, issues);
  checkUniqueIds('shocks.json', data.shocks, issues);
  for (const shock of data.shocks) {
    for (const effect of shock.effects) {
      if (!data.buildings.some((b) => b.id === effect.building)) {
        issues.push(`shocks.json: ${shock.id}: неизвестное здание "${effect.building}"`);
      }
    }
  }

  for (const recipe of data.recipes) {
    const where = `recipes.json: ${recipe.id}`;
    needGood(where, recipe.output.good);
    for (const input of recipe.inputs) {
      needGood(where, input.good);
      if (input.good === recipe.output.good) issues.push(`${where}: товар "${input.good}" — и вход, и выход`);
    }
  }

  for (const building of data.buildings) {
    const where = `buildings.json: ${building.id}`;
    if (building.kind === 'producer' && !recipeIds.has(building.recipe)) {
      issues.push(`${where}: неизвестный рецепт "${building.recipe}"`);
    }
    if (building.kind === 'storage') {
      for (const good of building.storedGoods) needGood(where, good);
    }
  }

  for (const good of Object.keys(data.balance.demand.goods)) needGood('balance.json: demand.goods', good);
  needGood('balance.json: logistics.fuelGood', data.balance.logistics.fuelGood);
  needGood('balance.json: catastrophe.famineGood', data.balance.catastrophe.famineGood);
  if (data.buildings.filter((b) => b.kind === 'route').length !== 1) {
    issues.push('buildings.json: нужно ровно одно здание вида route (полоса дороги)');
  }
  if (data.buildings.filter((b) => b.kind === 'fleet').length !== 1) {
    issues.push('buildings.json: нужно ровно одно здание вида fleet (автопарк)');
  }
  for (const good of Object.keys(data.balance.cpiWeights)) {
    needGood('balance.json: cpiWeights', good);
    if (!(good in data.balance.demand.goods)) {
      issues.push(`balance.json: cpiWeights: товар "${good}" в корзине ИПЦ, но домохозяйства его не покупают (нет в demand.goods)`);
    }
  }
}

/** Валидирует сырой JSON-контент и возвращает типизированные данные или бросает GameDataError со всеми ошибками сразу. */
export function loadGameData(raw: RawGameData): GameData {
  const issues: string[] = [];
  const balance = parseFile('balance.json', balanceSchema, raw.balance, issues);
  const goods = parseFile('goods.json', goodsFileSchema, raw.goods, issues);
  const recipes = parseFile('recipes.json', recipesFileSchema, raw.recipes, issues);
  const buildings = parseFile('buildings.json', buildingsFileSchema, raw.buildings, issues);
  const shocks = parseFile('shocks.json', shocksFileSchema, raw.shocks, issues);

  if (!balance || !goods || !recipes || !buildings || !shocks) throw new GameDataError(issues);

  const data: GameData = {
    balance,
    goods: goods.goods,
    recipes: recipes.recipes,
    buildings: buildings.buildings,
    shocks: shocks.shocks,
  };
  checkReferences(data, issues);
  if (issues.length > 0) throw new GameDataError(issues);
  return data;
}

/**
 * Наследование сценариев: `"extends": "baseline"` — поля верхнего уровня заменяют поля базового сценария
 * (карта, дороги, провинции берутся из базового, если не заданы). getRaw возвращает сырой JSON по имени файла.
 */
export function resolveScenario(name: string, getRaw: (name: string) => unknown, seen: ReadonlySet<string> = new Set()): unknown {
  if (seen.has(name)) throw new GameDataError([`${name}.json: циклическое наследование сценариев`]);
  const raw = getRaw(name);
  if (raw === null || typeof raw !== 'object' || !('extends' in raw)) return raw;
  const { extends: base, ...own } = raw as Record<string, unknown>;
  if (typeof base !== 'string') throw new GameDataError([`${name}.json: extends — имя сценария`]);
  const parent = resolveScenario(base, getRaw, new Set([...seen, name]));
  return { ...(parent as Record<string, unknown>), ...own };
}

/** Валидирует сценарий (стартовое состояние) против уже загруженных данных игры. */
export function loadScenario(raw: unknown, data: GameData, file = 'scenario'): Scenario {
  const issues: string[] = [];
  const scenario = parseFile(file, scenarioSchema, raw, issues);
  if (!scenario) throw new GameDataError(issues);

  checkUniqueIds(file, scenario.provinces, issues);
  const provinceIds = new Set(scenario.provinces.map((p) => p.id));
  const producers = new Set(data.buildings.filter((b) => b.kind === 'producer').map((b) => b.id));
  for (const province of scenario.provinces) {
    if (province.laborForce > province.population) {
      issues.push(`${file}: ${province.id}: рабочая сила больше населения`);
    }
  }
  for (const good of Object.keys(scenario.priceCeilings ?? {})) {
    if (!data.goods.some((g) => g.id === good)) issues.push(`${file}: потолок цены: неизвестный товар "${good}"`);
  }
  for (const firm of scenario.firms) {
    if (!producers.has(firm.building)) issues.push(`${file}: "${firm.building}" не производственное здание`);
    if (!provinceIds.has(firm.province)) issues.push(`${file}: неизвестная провинция "${firm.province}"`);
  }
  const storages = new Map(data.buildings.filter((b) => b.kind === 'storage').map((b) => [b.id, b]));
  for (const s of scenario.reserve.storages) {
    if (!storages.has(s.building)) issues.push(`${file}: резерв: "${s.building}" не склад`);
    if (!provinceIds.has(s.province)) issues.push(`${file}: резерв: неизвестная провинция "${s.province}"`);
  }
  for (const item of scenario.reserve.stock) {
    const fits = scenario.reserve.storages.some(
      (s) => s.province === item.province && storages.get(s.building)?.kind === 'storage' && storages.get(s.building)!.storedGoods.includes(item.good),
    );
    if (!fits) issues.push(`${file}: резерв: "${item.good}" в провинции "${item.province}" негде хранить`);
  }

  for (const p of scenario.provinces) {
    if (!scenario.map.provinces[p.id]) issues.push(`${file}: карта: нет раскладки провинции "${p.id}"`);
  }
  for (const route of Object.keys(scenario.map.routes)) {
    if (!scenario.routes.some((r) => r.id === route)) issues.push(`${file}: карта: изгиб неизвестной дороги "${route}"`);
  }

  checkUniqueIds(file, scenario.routes, issues);
  const pairs = new Set<string>();
  for (const route of scenario.routes) {
    for (const end of [route.a, route.b]) {
      if (!provinceIds.has(end)) issues.push(`${file}: дорога ${route.id}: неизвестная провинция "${end}"`);
    }
    if (route.a === route.b) issues.push(`${file}: дорога ${route.id} ведёт в ту же провинцию`);
    const pair = [route.a, route.b].sort().join('|');
    if (pairs.has(pair)) issues.push(`${file}: дорога ${route.id} дублирует другую дорогу между теми же провинциями`);
    pairs.add(pair);
  }
  if (issues.length > 0) throw new GameDataError(issues);
  return scenario;
}

/** Валидирует уровень: ссылки на сценарий, шоки, здания и товары, сроки событий и целей. */
export function loadLevel(raw: unknown, data: GameData, scenarios: Readonly<Record<string, Scenario>>, file = 'level'): Level {
  const issues: string[] = [];
  const level = parseFile(file, levelSchema, raw, issues);
  if (!level) throw new GameDataError(issues);

  if (!scenarios[level.scenario]) issues.push(`${file}: неизвестный сценарий "${level.scenario}"`);
  const goodIds = new Set(data.goods.map((g) => g.id));
  // Игрок строит инфраструктуру и госпредприятия (любое производственное здание — в собственности государства, GDD 3).
  for (const b of level.buildings) {
    if (!data.buildings.some((x) => x.id === b)) issues.push(`${file}: "${b}" нет в buildings.json`);
  }
  const provinces = new Set(scenarios[level.scenario]?.provinces.map((p) => p.id) ?? []);
  for (const e of level.events) {
    const shock = data.shocks.find((s) => s.id === e.shock);
    if (!shock) issues.push(`${file}: неизвестный шок "${e.shock}"`);
    for (const effect of shock?.effects ?? []) {
      if (effect.province !== undefined && !provinces.has(effect.province)) {
        issues.push(`${file}: шок "${e.shock}" ссылается на провинцию "${effect.province}", которой нет в сценарии`);
      }
    }
    if (e.turn > level.turns) issues.push(`${file}: шок "${e.shock}" на ходу ${e.turn} — позже конца уровня (${level.turns})`);
  }
  checkUniqueIds(file, level.goals, issues);
  for (const star of [1, 2, 3]) {
    if (!level.goals.some((g) => g.star === star)) issues.push(`${file}: нет ни одной цели на звезду ${star}`);
  }
  for (const goal of level.goals) {
    const c = goal.condition;
    if (c.kind !== 'metric') continue;
    const good = /^(?:shortage|maxShortage|price)\.(.+)$/.exec(c.metric)?.[1];
    if (good !== undefined && !goodIds.has(good)) issues.push(`${file}: цель ${goal.id}: неизвестный товар "${good}"`);
    if (c.when === 'streak' && c.turns === undefined) issues.push(`${file}: цель ${goal.id}: для streak нужно turns`);
    if (c.when !== 'streak' && c.turns !== undefined) issues.push(`${file}: цель ${goal.id}: turns только для streak`);
    if ((c.from ?? 1) + (c.turns ?? 1) - 1 > level.turns) issues.push(`${file}: цель ${goal.id}: не помещается в срок уровня`);
  }
  if (issues.length > 0) throw new GameDataError(issues);
  return level;
}
