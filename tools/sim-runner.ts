// Headless-прогон для балансировки (CLAUDE.md):
//   npm run sim -- --scenario baseline --seed 42 --policy passive --turns 24
//   npm run sim -- --policy all            — все боты и сравнение итогов
//   --format table|csv|json
// Печатает метрики по ходам: ИПЦ, инфляцию, ИЦП, безработицу, зарплату, цены, дефицит, бюджет, долг.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGameData, loadScenario, type GameData } from '../src/data';
import { createInitialState, Rng, step, type WorldState } from '../src/sim';
import { policies, policyNames } from './policies';

export interface RunnerOptions {
  scenario: string;
  seed: number;
  policy: string;
  turns: number;
  format: 'table' | 'csv' | 'json';
}

export interface Row {
  turn: number;
  cpi: number;
  inflationMoM: number;
  ppi: number;
  unemployment: number;
  wage: number;
  prices: Record<string, number>;
  /** Наибольший по провинциям дефицит товара у населения. */
  maxShortage: Record<string, number>;
  budgetBalance: number;
  debt: number;
  firms: number;
  events: string[];
}

const DEFAULTS: RunnerOptions = { scenario: 'baseline', seed: 42, policy: 'passive', turns: 24, format: 'table' };

export function parseArgs(argv: readonly string[]): RunnerOptions {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    switch (flag) {
      case '--level':
        throw new Error('Уровни появятся в M11. Пока используйте --scenario (файлы data/scenarios/*.json).');
      case '--scenario':
        options.scenario = value ?? options.scenario;
        i++;
        break;
      case '--seed':
        options.seed = Number(value);
        i++;
        break;
      case '--policy':
        options.policy = value ?? options.policy;
        i++;
        break;
      case '--turns':
        options.turns = Number(value);
        i++;
        break;
      case '--format':
        if (value !== 'table' && value !== 'csv' && value !== 'json') throw new Error(`Формат: table, csv или json, а не "${value}"`);
        options.format = value;
        i++;
        break;
      default:
        throw new Error(`Неизвестный параметр "${flag}"`);
    }
  }
  if (!Number.isInteger(options.seed)) throw new Error('--seed должен быть целым числом');
  if (!Number.isInteger(options.turns) || options.turns < 1) throw new Error('--turns должен быть целым числом ≥ 1');
  if (options.policy !== 'all' && !(options.policy in policies)) {
    throw new Error(`Политика: ${policyNames.join(', ')} или all, а не "${options.policy}"`);
  }
  return options;
}

export function loadScenarioFile(name: string, data: GameData) {
  const file = join(import.meta.dirname, '..', 'data', 'scenarios', `${name}.json`);
  return loadScenario(JSON.parse(readFileSync(file, 'utf8')), data, `${name}.json`);
}

function row(state: WorldState, events: string[]): Row {
  const m = state.metrics;
  const prices: Record<string, number> = {};
  for (const [g, market] of Object.entries(state.market)) prices[g] = market.price;
  const maxShortage: Record<string, number> = {};
  for (const byGood of Object.values(m.provinceShortage)) {
    for (const [g, v] of Object.entries(byGood)) maxShortage[g] = Math.max(maxShortage[g] ?? 0, v);
  }
  return {
    turn: state.turn,
    cpi: m.cpi,
    inflationMoM: m.inflationMoM,
    ppi: m.ppi,
    unemployment: m.unemployment,
    wage: state.wage,
    prices,
    maxShortage,
    budgetBalance: m.budgetBalance,
    debt: state.government.debt,
    firms: state.firms.length,
    events,
  };
}

/** Прогон сценария с ботом: строки по ходам, первая — старт. */
export function simulate(options: Omit<RunnerOptions, 'format'>, data: GameData = getGameData()): Row[] {
  const policy = policies[options.policy];
  if (!policy) throw new Error(`Нет политики "${options.policy}"`);
  const rng = new Rng(options.seed);
  let state = createInitialState(data, loadScenarioFile(options.scenario, data));
  const rows = [row(state, [])];
  for (let t = 1; t <= options.turns; t++) {
    const actions = policy(state, t, data);
    state = step(state, actions, rng, data).state;
    const events = [
      ...actions.map((a) => a.type),
      ...state.metrics.firmsOpened.map((id) => `+${id}`),
      ...state.metrics.firmsClosed.map((id) => `-${id}`),
      ...state.activeShocks.map((s) => `шок:${s.id}`),
    ];
    rows.push(row(state, events));
  }
  return rows;
}

const pct = (x: number) => (x * 100).toFixed(1);
const fix = (x: number, d = 2) => x.toFixed(d);

const COLUMNS: { title: string; value: (r: Row) => string }[] = [
  { title: 'ход', value: (r) => String(r.turn) },
  { title: 'ИПЦ', value: (r) => fix(r.cpi) },
  { title: 'инфл%', value: (r) => fix(r.inflationMoM * 100) },
  { title: 'ИЦП', value: (r) => fix(r.ppi) },
  { title: 'безр%', value: (r) => pct(r.unemployment) },
  { title: 'зарпл', value: (r) => fix(r.wage) },
  { title: 'хлеб', value: (r) => fix(r.prices.bread ?? 0) },
  { title: 'мука', value: (r) => fix(r.prices.flour ?? 0) },
  { title: 'топл', value: (r) => fix(r.prices.fuel ?? 0) },
  { title: 'деф.хлеб%', value: (r) => pct(r.maxShortage.bread ?? 0) },
  { title: 'деф.топл%', value: (r) => pct(r.maxShortage.fuel ?? 0) },
  { title: 'бюджет', value: (r) => fix(r.budgetBalance, 0) },
  { title: 'долг', value: (r) => fix(r.debt, 0) },
  { title: 'фирм', value: (r) => String(r.firms) },
  { title: 'события', value: (r) => r.events.join(' ') },
];

export function formatTable(rows: readonly Row[]): string {
  const cells = [COLUMNS.map((c) => c.title), ...rows.map((r) => COLUMNS.map((c) => c.value(r)))];
  const widths = COLUMNS.map((_, i) => Math.max(...cells.map((line) => line[i]!.length)));
  return cells
    .map((line) => line.map((cell, i) => (i === line.length - 1 ? cell : cell.padStart(widths[i]!))).join('  ').trimEnd())
    .join('\n');
}

export function formatCsv(rows: readonly Row[]): string {
  return [COLUMNS.map((c) => c.title).join(','), ...rows.map((r) => COLUMNS.map((c) => c.value(r)).join(','))].join('\n');
}

/** Итоги разных ботов рядом: чтобы видеть, что у разных стратегий разные исходы. */
export function formatComparison(results: Record<string, readonly Row[]>): string {
  const summary = Object.entries(results).map(([policy, rows]) => {
    const last = rows.at(-1)!;
    const maxUnemployment = Math.max(...rows.map((r) => r.unemployment));
    const maxShortage = Math.max(...rows.map((r) => Math.max(0, ...Object.values(r.maxShortage))));
    return [policy, fix(last.cpi), pct(last.unemployment), pct(maxUnemployment), pct(maxShortage), fix(last.debt, 0), String(last.firms)];
  });
  const header = ['бот', 'ИПЦ итог', 'безр% итог', 'безр% макс', 'дефицит% макс', 'долг', 'фирм'];
  const cells = [header, ...summary];
  const widths = header.map((_, i) => Math.max(...cells.map((line) => line[i]!.length)));
  return cells.map((line) => line.map((cell, i) => cell.padStart(widths[i]!)).join('  ')).join('\n');
}

export function main(argv: readonly string[]): string {
  const options = parseArgs(argv);
  const names = options.policy === 'all' ? policyNames : [options.policy];
  const results: Record<string, Row[]> = {};
  for (const name of names) results[name] = simulate({ ...options, policy: name });
  if (options.format === 'json') return JSON.stringify(options.policy === 'all' ? results : results[options.policy], null, 1);
  const format = options.format === 'csv' ? formatCsv : formatTable;
  const parts = names.map((name) => `# ${options.scenario}, seed ${options.seed}, бот ${name}, ${options.turns} ходов\n${format(results[name]!)}`);
  if (names.length > 1) parts.push(`# сравнение ботов\n${formatComparison(results)}`);
  return parts.join('\n\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
