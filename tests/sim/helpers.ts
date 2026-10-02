import scenarioRaw from '../../data/scenarios/baseline.json';
import { getGameData, loadScenario, type GameData, type Scenario } from '../../src/data';
import { createInitialState, Rng, step, type Action, type CauseEvent, type WorldState } from '../../src/sim';

export const SEED = 42;

export type ScenarioPatch = (scenario: Scenario) => void;

export function baseline(data: GameData = getGameData(), patch?: ScenarioPatch): WorldState {
  const scenario = structuredClone(scenarioRaw) as Scenario;
  patch?.(scenario);
  return createInitialState(data, loadScenario(scenario, data));
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
  patch?: ScenarioPatch,
): Run {
  const rng = new Rng(SEED);
  const states = [baseline(data, patch)];
  const causes: CauseEvent[][] = [[]];
  for (let t = 1; t <= turns; t++) {
    const result = step(states[t - 1]!, actionsAt(t), rng, data);
    states.push(result.state);
    causes.push(result.causes);
  }
  return { states, causes };
}

export function totalMoney(state: WorldState): number {
  // Кредит создаёт деньги вместе с долгом, поэтому сохраняется «деньги − долги (+ списанные долги)».
  let total = state.government.cash + state.logistics.cash + state.bank.cash - state.government.debt - state.bank.writtenOff;
  for (const p of state.provinces) total += p.households.cash;
  for (const f of state.firms) total += f.cash - f.debt;
  return total;
}
