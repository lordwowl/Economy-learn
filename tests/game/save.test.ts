import { describe, expect, it } from 'vitest';
import { getGameData, getLevels, getScenarios } from '../../src/data';
import { advanceLevel } from '../../src/game/level';
import { newSession, parseProgress, parseSave, restore, toSave, withStars, type GameMode } from '../../src/game/save';
import { addDecision, endTurn, type Session } from '../../src/game/session';
import { readStored, writeStored } from '../../src/game/storage';
import type { Action } from '../../src/sim';

const data = getGameData();
const levels = getLevels();
const scenarios = getScenarios();
const harvest = levels.find((l) => l.id === 'harvest')!;

function play(mode: GameMode, seed: number, turns: number, decide: (turn: number) => Action[]): Session {
  let s = newSession(data, mode, seed, levels, scenarios);
  for (let t = 1; t <= turns; t++) {
    for (const a of decide(t)) s = addDecision(s, a);
    s = mode.kind === 'level' ? advanceLevel(s, data, harvest, 1) : endTurn(s, data);
  }
  return s;
}

describe('сохранения (localStorage, повторный прогон)', () => {
  it('уровень: восстановление даёт ту же историю, включая шоки уровня и решения текущего хода', () => {
    const mode: GameMode = { kind: 'level', level: 'harvest' };
    let s = play(mode, harvest.seed, 7, (t) =>
      t === 5
        ? [
            { type: 'reserveRelease', good: 'grain', province: 'north', quantity: 100 },
            { type: 'setTax', tax: 'sales', rate: 0.08 },
          ]
        : [],
    );
    s = addDecision(s, { type: 'setKeyRate', rate: 0.07 });
    const save = parseSave(JSON.stringify(toSave(mode, s)))!;
    expect(save).toBeDefined();
    const restored = restore(save, data, levels, scenarios);
    expect(restored.history.map((h) => h.state)).toEqual(s.history.map((h) => h.state));
    expect(restored.history.map((h) => h.events)).toEqual(s.history.map((h) => h.events));
    expect(restored.decisions).toEqual(s.decisions);
    expect(restored.rngState).toBe(s.rngState);
  });

  it('песочница: свой сценарий, seed и шоки-решения', () => {
    const mode: GameMode = { kind: 'sandbox', scenario: 'overheating' };
    const s = play(mode, 7, 4, (t) => (t === 2 ? [{ type: 'shock', shock: 'refineryAccident' }] : []));
    const restored = restore(parseSave(JSON.stringify(toSave(mode, s)))!, data, levels, scenarios);
    expect(restored.seed).toBe(7);
    expect(restored.history.map((h) => h.state)).toEqual(s.history.map((h) => h.state));
  });

  it('сохранение компактное: решения, а не состояния мира', () => {
    const s = play({ kind: 'level', level: 'harvest' }, harvest.seed, harvest.turns, () => []);
    expect(JSON.stringify(toSave({ kind: 'level', level: 'harvest' }, s)).length).toBeLessThan(1000);
  });

  it('повреждённое, старое или чужое сохранение — как будто его нет', () => {
    expect(parseSave(null)).toBeUndefined();
    expect(parseSave('{не json')).toBeUndefined();
    expect(parseSave(JSON.stringify({ version: 99, mode: { kind: 'sandbox', scenario: 'baseline' }, seed: 1, turns: [], decisions: [] }))).toBeUndefined();
    expect(
      parseSave(JSON.stringify({ version: 1, mode: { kind: 'sandbox', scenario: 'baseline' }, seed: 1, turns: [[{ type: 'nuke' }]], decisions: [] })),
    ).toBeUndefined();
  });

  it('лучшие звёзды не уменьшаются; испорченный прогресс — пустой', () => {
    let p = parseProgress(null);
    p = withStars(p, 'chain', 2);
    p = withStars(p, 'chain', 1);
    p = withStars(p, 'harvest', 3);
    expect(parseProgress(JSON.stringify(p)).stars).toEqual({ chain: 2, harvest: 3 });
    expect(parseProgress('мусор').stars).toEqual({});
  });

  it('без localStorage игра работает: чтение — null, запись не падает', () => {
    expect(readStored('save')).toBeNull();
    expect(() => writeStored('save', 'x')).not.toThrow();
  });
});
