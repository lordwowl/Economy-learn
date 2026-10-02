import balance from '../../data/balance.json';
import buildings from '../../data/buildings.json';
import explanations from '../../data/explanations.json';
import goods from '../../data/goods.json';
import level03 from '../../data/levels/03_chain.json';
import level05 from '../../data/levels/05_harvest.json';
import level06 from '../../data/levels/06_ceiling.json';
import level09 from '../../data/levels/09_overheating.json';
import recipes from '../../data/recipes.json';
import baseline from '../../data/scenarios/baseline.json';
import ceiling from '../../data/scenarios/ceiling.json';
import chain from '../../data/scenarios/chain.json';
import harvest from '../../data/scenarios/harvest.json';
import overheating from '../../data/scenarios/overheating.json';
import shocks from '../../data/shocks.json';
import { loadGameData, loadLevel, loadScenario, resolveScenario, type GameData } from './load';
import { explanationsFileSchema, type Explanations, type Level, type Scenario } from './schemas';

export { loadGameData, loadLevel, loadScenario, resolveScenario, GameDataError, type GameData, type RawGameData } from './load';
export type * from './schemas';
export { LEVERS } from './schemas';

/** Сценарии (стартовые состояния) из data/scenarios/: имя файла → JSON. */
const RAW_SCENARIOS: Record<string, unknown> = { baseline, chain, harvest, ceiling, overheating };
/** Уровни кампании из data/levels/: имя файла → JSON. */
const RAW_LEVELS: Record<string, unknown> = { '03_chain': level03, '05_harvest': level05, '06_ceiling': level06, '09_overheating': level09 };

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
  const getRaw = (name: string) => {
    const raw = RAW_SCENARIOS[name];
    if (raw === undefined) throw new Error(`Нет сценария "${name}"`);
    return raw;
  };
  cachedScenarios ??= Object.fromEntries(Object.keys(RAW_SCENARIOS).map((name) => [name, loadScenario(resolveScenario(name, getRaw), data, `${name}.json`)]));
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
