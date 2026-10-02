// Сессия игры: состояние мира, история ходов и решения текущего хода (GDD 4).
// Решения копятся в течение хода, их можно отменить; применяются по кнопке хода.
// Состояние сериализуемо (seed и состояние генератора хранятся числами) — пригодится для сохранений (M12).

import type { GameData } from '../data';
import type { Scenario } from '../data/schemas';
import { createInitialState, Rng, step, type Action, type CauseEvent, type WorldState } from '../sim';

export interface TurnRecord {
  state: WorldState;
  /** События причинного журнала этого хода. */
  causes: CauseEvent[];
  /** Решения, применённые в этом ходу. */
  actions: Action[];
}

export interface Session {
  seed: number;
  rngState: number;
  /** history[0] — старт уровня. */
  history: TurnRecord[];
  /** Решения текущего хода, ещё не применённые. */
  decisions: Action[];
}

export function createSession(data: GameData, scenario: Scenario, seed: number): Session {
  return {
    seed,
    rngState: new Rng(seed).state,
    history: [{ state: createInitialState(data, scenario), causes: [], actions: [] }],
    decisions: [],
  };
}

export function currentState(session: Session): WorldState {
  return session.history.at(-1)!.state;
}

export function previousState(session: Session): WorldState | undefined {
  return session.history.at(-2)?.state;
}

/**
 * Ключ рычага: повторное решение по тому же рычагу заменяет прежнее (ставку меняют один раз за ход).
 * Стройки складываются — у них ключа нет.
 */
export function decisionKey(action: Action): string | undefined {
  switch (action.type) {
    case 'setKeyRate':
      return 'keyRate';
    case 'setTax':
      return `tax.${action.tax}`;
    case 'setTransfers':
      return 'transfers';
    case 'setSubsidy':
      return `subsidy.${action.good}`;
    case 'setPriceCeiling':
      return `ceiling.${action.good}`;
    case 'reserveBuy':
    case 'reserveRelease':
      return `${action.type}.${action.good}.${action.province}`;
    default:
      return undefined;
  }
}

export function addDecision(session: Session, action: Action): Session {
  const key = decisionKey(action);
  const decisions = key === undefined ? [...session.decisions] : session.decisions.filter((d) => decisionKey(d) !== key);
  return { ...session, decisions: [...decisions, action] };
}

export function removeDecision(session: Session, index: number): Session {
  return { ...session, decisions: session.decisions.filter((_, i) => i !== index) };
}

/** Ход: решения игрока (+ события уровня, например шоки) → новый месяц. */
export function endTurn(session: Session, data: GameData, events: readonly Action[] = []): Session {
  const rng = new Rng(session.rngState);
  const actions = [...session.decisions, ...events];
  const result = step(currentState(session), actions, rng, data);
  return {
    ...session,
    rngState: rng.state,
    history: [...session.history, { state: result.state, causes: result.causes, actions }],
    decisions: [],
  };
}

/** «Перемотать»: первый ход — с решениями игрока, остальные — без. */
export function fastForward(session: Session, data: GameData, turns: number): Session {
  let s = session;
  for (let i = 0; i < turns; i++) s = endTurn(s, data);
  return s;
}
