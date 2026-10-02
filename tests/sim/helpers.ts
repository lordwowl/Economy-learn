import scenarioRaw from '../../data/scenarios/baseline.json';
import { getGameData, loadScenario, type GameData } from '../../src/data';
import { createInitialState, Rng, step, type Action, type CauseEvent, type WorldState } from '../../src/sim';

export const SEED = 42;

export function baseline(data: GameData = getGameData()): WorldState {
  return createInitialState(data, loadScenario(scenarioRaw, data));
}

export interface Run {
  states: WorldState[];
  causes: CauseEvent[][];
}

/** Прогон: states[0] — старт, states[t] — после хода t. */
export function run(
  turns: number,
  actionsAt: (turn: number) => Action[] = () => [],
  data: GameData = getGameData(),
): Run {
  const rng = new Rng(SEED);
  const states = [baseline(data)];
  const causes: CauseEvent[][] = [[]];
  for (let t = 1; t <= turns; t++) {
    const result = step(states[t - 1]!, actionsAt(t), rng, data);
    states.push(result.state);
    causes.push(result.causes);
  }
  return { states, causes };
}

export function totalMoney(state: WorldState): number {
  let total = state.government.cash;
  for (const p of state.provinces) total += p.households.cash;
  for (const f of state.firms) total += f.cash;
  return total;
}
