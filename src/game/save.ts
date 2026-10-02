// Сохранения (GDD 2, CLAUDE.md: только localStorage). Модель детерминирована, поэтому сохраняются не состояния мира,
// а то, что их порождает: уровень или сценарий песочницы, seed и решения игрока по ходам. Загрузка — повторный прогон.

import { z } from 'zod';
import type { GameData, Level, Scenario } from '../data';
import type { Action } from '../sim';
import { advanceLevel } from './level';
import { addDecision, createSession, endTurn, type Session } from './session';

const SAVE_VERSION = 1;
const id = z.string().min(1);
const good = id;

export const actionSchema: z.ZodType<Action> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('setKeyRate'), rate: z.number().finite() }),
  z.strictObject({ type: z.literal('addRoadLane'), route: id }),
  z.strictObject({ type: z.literal('setTax'), tax: z.enum(['sales', 'profit', 'income']), rate: z.number().finite() }),
  z.strictObject({ type: z.literal('setTransfers'), perCapita: z.number().finite() }),
  z.strictObject({ type: z.literal('setSubsidy'), good, perUnit: z.number().finite() }),
  z.strictObject({ type: z.literal('setPriceCeiling'), good, price: z.number().finite().nullable() }),
  z.strictObject({ type: z.literal('buildStorage'), building: id, province: id }),
  z.strictObject({ type: z.literal('shock'), shock: id }),
  z.strictObject({ type: z.literal('buildStateFleet') }),
  z.strictObject({ type: z.literal('buildStateFirm'), building: id, province: id }),
  z.strictObject({ type: z.literal('reserveBuy'), good, province: id, quantity: z.number().finite() }),
  z.strictObject({ type: z.literal('reserveRelease'), good, province: id, quantity: z.number().finite() }),
]);

/** Что играем: уровень кампании или песочница со сценарием. */
export type GameMode = { kind: 'level'; level: string } | { kind: 'sandbox'; scenario: string };

export const savedGameSchema = z.strictObject({
  version: z.literal(SAVE_VERSION),
  mode: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('level'), level: id }), z.strictObject({ kind: z.literal('sandbox'), scenario: id })]),
  seed: z.number().int(),
  /** Решения игрока по сыгранным ходам: turns[0] — решения первого хода. */
  turns: z.array(z.array(actionSchema)),
  /** Решения текущего, ещё не сыгранного хода. */
  decisions: z.array(actionSchema),
});

export type SavedGame = z.infer<typeof savedGameSchema>;

export function toSave(mode: GameMode, session: Session): SavedGame {
  return {
    version: SAVE_VERSION,
    mode,
    seed: session.seed,
    turns: session.history.slice(1).map((h) => h.actions),
    decisions: session.decisions,
  };
}

/** Новая сессия режима: уровень — со своим сценарием, песочница — с выбранным; seed — уровня или из кода сценария. */
export function newSession(data: GameData, mode: GameMode, seed: number, levels: readonly Level[], scenarios: Readonly<Record<string, Scenario>>): Session {
  const name = mode.kind === 'level' ? levels.find((l) => l.id === mode.level)?.scenario : mode.scenario;
  const scenario = name !== undefined ? scenarios[name] : undefined;
  if (!scenario) throw new Error(`Нет уровня или сценария для ${JSON.stringify(mode)}`);
  return createSession(data, scenario, seed);
}

/** Восстановление: повторный прогон решений с тем же seed (шоки уровня приходят сами). */
export function restore(save: SavedGame, data: GameData, levels: readonly Level[], scenarios: Readonly<Record<string, Scenario>>): Session {
  let session = newSession(data, save.mode, save.seed, levels, scenarios);
  const level = save.mode.kind === 'level' ? levels.find((l) => l.id === (save.mode as { level: string }).level) : undefined;
  for (const actions of save.turns) {
    for (const action of actions) session = addDecision(session, action);
    session = level ? advanceLevel(session, data, level, 1) : endTurn(session, data);
  }
  for (const action of save.decisions) session = addDecision(session, action);
  return session;
}

/** Разбор сохранения из хранилища: повреждённое или старое — как будто его нет. */
export function parseSave(raw: string | null): SavedGame | undefined {
  if (raw === null) return undefined;
  try {
    const result = savedGameSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Лучшие звёзды по уровням. */
export const progressSchema = z.strictObject({ version: z.literal(SAVE_VERSION), stars: z.record(id, z.number().int().min(0).max(3)) });
export type Progress = z.infer<typeof progressSchema>;

export function parseProgress(raw: string | null): Progress {
  const empty: Progress = { version: SAVE_VERSION, stars: {} };
  if (raw === null) return empty;
  try {
    const result = progressSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : empty;
  } catch {
    return empty;
  }
}

export function withStars(progress: Progress, level: string, stars: number): Progress {
  return { ...progress, stars: { ...progress.stars, [level]: Math.max(progress.stars[level] ?? 0, stars) } };
}
