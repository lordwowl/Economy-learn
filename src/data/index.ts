import balance from '../../data/balance.json';
import buildings from '../../data/buildings.json';
import explanations from '../../data/explanations.json';
import goods from '../../data/goods.json';
import recipes from '../../data/recipes.json';
import shocks from '../../data/shocks.json';
import { loadGameData, type GameData } from './load';
import { explanationsFileSchema, type Explanations } from './schemas';

export { loadGameData, loadScenario, GameDataError, type GameData, type RawGameData } from './load';
export type * from './schemas';

let cached: GameData | undefined;
let cachedExplanations: Explanations | undefined;

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
