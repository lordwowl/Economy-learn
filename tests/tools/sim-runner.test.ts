import { describe, expect, it } from 'vitest';
import { formatComparison, formatTable, main, parseArgs, simulate } from '../../tools/sim-runner';

describe('sim-runner', () => {
  it('параметры по умолчанию и разбор флагов', () => {
    expect(parseArgs([])).toEqual({ scenario: 'baseline', seed: 42, policy: 'passive', turns: 24, format: 'table' });
    expect(parseArgs(['--policy', 'hawk', '--turns', '6', '--format', 'csv']).policy).toBe('hawk');
    expect(() => parseArgs(['--policy', 'nope'])).toThrow(/Политика/);
    expect(() => parseArgs(['--level', '99'])).toThrow(/Нет уровня/);
    expect(() => parseArgs(['--level', '05', '--scenario', 'baseline'])).toThrow(/вместе нельзя/);
    expect(() => parseArgs(['--turns', '0'])).toThrow(/turns/);
  });

  it('строка на каждый ход плюс старт; таблица с заголовком', () => {
    const { rows } = simulate({ scenario: 'baseline', seed: 42, policy: 'passive', turns: 6 });
    expect(rows).toHaveLength(7);
    const table = formatTable(rows).split('\n');
    expect(table[0]).toMatch(/ход\s+ИПЦ/);
    expect(table).toHaveLength(8);
  });

  it('у разных стратегий разные исходы: ставка ↑ — ниже цены, ставка ↓ — выше', () => {
    const rows = (policy: string) => simulate({ scenario: 'baseline', seed: 42, policy, turns: 18 }).rows;
    const at = (policy: string) => rows(policy).at(-1)!;
    const peakUnemployment = (policy: string) => Math.max(...rows(policy).map((r) => r.unemployment));
    expect(at('hawk').cpi).toBeLessThan(at('passive').cpi);
    expect(at('dove').cpi).toBeGreaterThan(at('passive').cpi);
    expect(peakUnemployment('hawk')).toBeGreaterThan(peakUnemployment('passive'));
  });

  it('--policy all печатает сравнение ботов', () => {
    const out = main(['--policy', 'all', '--turns', '4']);
    expect(out).toMatch(/# сравнение ботов/);
    expect(formatComparison({ passive: simulate({ scenario: 'baseline', seed: 42, policy: 'passive', turns: 2 }) })).toMatch(/passive/);
  });

  it('--level: сценарий, seed и срок из уровня, шоки по сценарию, итог по целям', () => {
    const options = parseArgs(['--level', '05']);
    expect(options).toMatchObject({ level: '05', scenario: 'harvest', seed: 42, turns: 24 });
    expect(parseArgs(['--level', 'harvest', '--seed', '7', '--turns', '6'])).toMatchObject({ seed: 7, turns: 6 });
    const { rows, level } = simulate({ ...options, policy: 'passive' });
    expect(rows).toHaveLength(25);
    expect(rows[4]!.events.join(' ')).toMatch(/шок:harvestFailure/);
    expect(level?.outcome).toBe('completed');
    const out = main(['--level', '05', '--policy', 'all']);
    expect(out).toMatch(/# итог уровня: пройден/);
    expect(out).toMatch(/уровень/);
  });

  it('на уровне бот может только то, что открыто игроку', () => {
    // Уровень 3: ставка закрыта — «ястреб» играет как пассивный бот.
    const passive = simulate({ ...parseArgs(['--level', '03']), policy: 'passive' }).rows;
    const hawk = simulate({ ...parseArgs(['--level', '03']), policy: 'hawk' }).rows;
    expect(hawk).toEqual(passive);
  });
});
