import balance from '../../data/balance.json';
import buildings from '../../data/buildings.json';
import explanations from '../../data/explanations.json';
import goods from '../../data/goods.json';
import level05 from '../../data/levels/05_harvest.json';
import recipes from '../../data/recipes.json';
import baseline from '../../data/scenarios/baseline.json';
import shocks from '../../data/shocks.json';
import { loadGameData, loadLevel, loadScenario, type GameData } from './load';
import { explanationsFileSchema, type Explanations, type Level, type Scenario } from './schemas';

export { loadGameData, loadLevel, loadScenario, GameDataError, type GameData, type RawGameData } from './load';
export type * from './schemas';
export { LEVERS } from './schemas';

/** Сценарии (стартовые состояния) из data/scenarios/: имя файла → JSON. */
const RAW_SCENARIOS: Record<string, unknown> = { baseline };
/** Уровни кампании из data/levels/: имя файла → JSON. */
const RAW_LEVELS: Record<string, unknown> = { '05_harvest': level05 };

let cached: GameData | undefined;
let cachedExplanations: Explanations | undefined;
let cachedScenarios: Record<string, Scenario> | undefined;
let cachedLevels: Level[] | undefined;

/** Встроенные в сборку данные игры, провалидированные один раз при первом обращении. */
export function getGameData(): GameData {
  cached ??= loadGameData({ balance, goods, recipes, buildings, shocks });
  return cached;
}

/** Шаблоны объяснений причин (только для UI и отчётов, симуляции не нужны). */
export function getExplanations(): Explanations {
  cachedExplanations ??= explanationsFileSchema.parse(explanations);
  return cachedExplanations;
}

export function getScenarios(): Record<string, Scenario> {
  const data = getGameData();
  cachedScenarios ??= Object.fromEntries(Object.entries(RAW_SCENARIOS).map(([name, raw]) => [name, loadScenario(raw, data, `${name}.json`)]));
  return cachedScenarios;
}

export function getScenario(name: string): Scenario {
  const scenario = getScenarios()[name];
  if (!scenario) throw new Error(`Нет сценария "${name}"`);
  return scenario;
}

/** Уровни кампании по порядку номеров. */
export function getLevels(): Level[] {
  const data = getGameData();
  cachedLevels ??= Object.entries(RAW_LEVELS)
    .map(([name, raw]) => loadLevel(raw, data, getScenarios(), `${name}.json`))
    .sort((a, b) => a.number - b.number);
  return cachedLevels;
}
