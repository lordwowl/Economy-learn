import balance from '../../data/balance.json';
import buildings from '../../data/buildings.json';
import goods from '../../data/goods.json';
import recipes from '../../data/recipes.json';
import shocks from '../../data/shocks.json';
import { loadGameData, type GameData } from './load';

export { loadGameData, loadScenario, GameDataError, type GameData, type RawGameData } from './load';
export type * from './schemas';

let cached: GameData | undefined;

/** Встроенные в сборку данные игры, провалидированные один раз при первом обращении. */
export function getGameData(): GameData {
  cached ??= loadGameData({ balance, goods, recipes, buildings, shocks });
  return cached;
}
