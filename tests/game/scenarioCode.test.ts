import { describe, expect, it } from 'vitest';
import { getLevels, getScenarios } from '../../src/data';
import {
  codeFromHash,
  decodeScenarioCode,
  encodeScenarioCode,
  normalizeCode,
  SANDBOX_SCENARIO_CODES,
  shareUrl,
  type ScenarioCode,
} from '../../src/game/scenarioCode';

const levels = getLevels();

describe('код сценария (GDD 8)', () => {
  it('уровни и сценарии песочницы туда и обратно, с любым seed', () => {
    const codes: ScenarioCode[] = [
      ...levels.map((l) => ({ mode: { kind: 'level' as const, level: l.id }, seed: l.seed })),
      ...SANDBOX_SCENARIO_CODES.map((scenario, i) => ({ mode: { kind: 'sandbox' as const, scenario }, seed: i * 1_000_003 })),
      { mode: { kind: 'level', level: 'chain' }, seed: 0 },
      { mode: { kind: 'level', level: 'chain' }, seed: 0xffffffff },
    ];
    for (const code of codes) {
      const text = encodeScenarioCode(code, levels);
      expect(text).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(decodeScenarioCode(text, levels)).toEqual(code);
    }
  });

  it('все сценарии песочницы из данных можно закодировать', () => {
    for (const id of Object.keys(getScenarios())) expect(SANDBOX_SCENARIO_CODES).toContain(id);
  });

  it('ученик может ошибиться в регистре, дефисах и похожих буквах', () => {
    const text = encodeScenarioCode({ mode: { kind: 'level', level: 'harvest' }, seed: 42 }, levels);
    const sloppy = ` ${text.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    expect(normalizeCode(sloppy)).toBe(text.replace(/-/g, ''));
    expect(decodeScenarioCode(sloppy, levels)).toEqual({ mode: { kind: 'level', level: 'harvest' }, seed: 42 });
  });

  it('опечатка ловится контрольной суммой, мусор — проверкой формата', () => {
    const text = encodeScenarioCode({ mode: { kind: 'level', level: 'ceiling' }, seed: 42 }, levels).replace(/-/g, '');
    let caught = 0;
    for (let i = 0; i < text.length; i++) {
      const swapped = text.slice(0, i) + (text[i] === 'Z' ? 'Y' : 'Z') + text.slice(i + 1);
      const result = decodeScenarioCode(swapped, levels);
      if (typeof result === 'string') caught++;
    }
    expect(caught).toBe(text.length);
    const last = text.slice(0, -1) + (text.endsWith('Z') ? 'Y' : 'Z');
    expect(decodeScenarioCode(last, levels)).toBe('checksum');
    expect(decodeScenarioCode('привет', levels)).toBe('format');
    expect(decodeScenarioCode('ABCD', levels)).toBe('format');
  });

  it('ссылка для QR: адрес страницы + #code=…, код читается из адреса', () => {
    const url = shareUrl('ABCD-EFGH-JKMN', 'https://example.org/Economy-learn/#old');
    expect(url).toBe('https://example.org/Economy-learn/#code=ABCD-EFGH-JKMN');
    expect(codeFromHash(new URL(url).hash)).toBe('ABCD-EFGH-JKMN');
    expect(codeFromHash('#other=1')).toBeUndefined();
  });
});
