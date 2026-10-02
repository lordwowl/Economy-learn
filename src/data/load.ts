import { z } from 'zod';
import {
  balanceSchema,
  buildingsFileSchema,
  goodsFileSchema,
  recipesFileSchema,
  type Balance,
  type Building,
  type Good,
  type Recipe,
} from './schemas';

export interface GameData {
  balance: Balance;
  goods: Good[];
  recipes: Recipe[];
  buildings: Building[];
}

export interface RawGameData {
  balance: unknown;
  goods: unknown;
  recipes: unknown;
  buildings: unknown;
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

  if (!balance || !goods || !recipes || !buildings) throw new GameDataError(issues);

  const data: GameData = {
    balance,
    goods: goods.goods,
    recipes: recipes.recipes,
    buildings: buildings.buildings,
  };
  checkReferences(data, issues);
  if (issues.length > 0) throw new GameDataError(issues);
  return data;
}
