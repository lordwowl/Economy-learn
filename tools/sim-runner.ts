// Headless-прогон для балансировки (CLAUDE.md):
//   npm run sim -- --scenario baseline --seed 42 --policy passive --turns 24
//   npm run sim -- --level 05 --policy all  — уровень: его сценарий, seed, срок и шоки + итог по целям и звёздам
//   npm run sim -- --policy all            — все боты и сравнение итогов
//   --format table|csv|json
// Печатает метрики по ходам: ИПЦ, инфляцию, ИЦП, безработицу, зарплату, цены, дефицит, бюджет, долг.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGameData, getLevels, getScenario, loadScenario, resolveScenario, type GameData, type Level } from '../src/data';
import { evaluateLevel, isAllowed, levelEvents, type LevelStatus } from '../src/game/level';
import { createInitialState, Rng, step, type Action, type WorldState } from '../src/sim';
import { policies, policyNames } from './policies';

export interface RunnerOptions {
  /** Номер ("05") или id уровня; тогда сценарий, seed и срок по умолчанию — из уровня. */
  level?: string;
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

export function findLevel(name: string): Level {
  const level = getLevels().find((l) => l.id === name || String(l.number).padStart(2, '0') === name.padStart(2, '0'));
  if (!level)
    throw new Error(
      `Нет уровня "${name}". Есть: ${getLevels()
        .map((l) => `${String(l.number).padStart(2, '0')} (${l.id})`)
        .join(', ')}`,
    );
  return level;
}

export function parseArgs(argv: readonly string[]): RunnerOptions {
  const options: RunnerOptions = { ...DEFAULTS };
  const given = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag !== undefined) given.add(flag);
    switch (flag) {
      case '--level':
        if (value === undefined) throw new Error('--level: укажите номер или id уровня');
        options.level = value;
        i++;
        break;
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
  if (options.level !== undefined) {
    const level = findLevel(options.level);
    if (given.has('--scenario')) throw new Error('--level и --scenario вместе нельзя: сценарий задаёт уровень');
    options.scenario = level.scenario;
    if (!given.has('--seed')) options.seed = level.seed;
    if (!given.has('--turns')) options.turns = level.turns;
  }
  if (!Number.isInteger(options.seed)) throw new Error('--seed должен быть целым числом');
  if (!Number.isInteger(options.turns) || options.turns < 1) throw new Error('--turns должен быть целым числом ≥ 1');
  if (options.policy !== 'all' && !(options.policy in policies)) {
    throw new Error(`Политика: ${policyNames.join(', ')} или all, а не "${options.policy}"`);
  }
  return options;
}

export function loadScenarioFile(name: string, data: GameData) {
  const read = (n: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'scenarios', `${n}.json`), 'utf8'));
  return loadScenario(resolveScenario(name, read), data, `${name}.json`);
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

export interface Simulation {
  rows: Row[];
  /** Итог уровня (только с --level): по первым level.turns ходам. */
  level?: LevelStatus;
}

/** Прогон сценария (или уровня) с ботом: строки по ходам, первая — старт. */
export function simulate(options: Omit<RunnerOptions, 'format'>, data: GameData = getGameData()): Simulation {
  const policy = policies[options.policy];
  if (!policy) throw new Error(`Нет политики "${options.policy}"`);
  const level = options.level !== undefined ? findLevel(options.level) : undefined;
  const rng = new Rng(options.seed);
  let state = createInitialState(data, level ? getScenario(level.scenario) : loadScenarioFile(options.scenario, data));
  const rows = [row(state, [])];
  const history: { state: WorldState; causes: []; actions: Action[]; events: Action[] }[] = [{ state, causes: [], actions: [], events: [] }];
  for (let t = 1; t <= options.turns; t++) {
    // На уровне бот может то же, что игрок: закрытые рычаги и стройки отбрасываются.
    const decisions = policy(state, t, data).filter((a) => !level || isAllowed(level, a, data));
    const shocks = level ? levelEvents(level, t) : [];
    const actions = [...decisions, ...shocks];
    state = step(state, actions, rng, data).state;
    history.push({ state, causes: [], actions: decisions, events: shocks });
    const events = [
      ...actions.map((a) => a.type),
      ...state.metrics.firmsOpened.map((id) => `+${id}`),
      ...state.metrics.firmsClosed.map((id) => `-${id}`),
      ...state.activeShocks.map((s) => `шок:${s.id}`),
    ];
    rows.push(row(state, events));
  }
  return { rows, ...(level ? { level: evaluateLevel(level, history.slice(0, level.turns + 1), data.balance) } : {}) };
}

const STAR_MARK = (stars: number) => '★'.repeat(stars) + '☆'.repeat(3 - stars);
const GOAL_MARK = { met: '✓', failed: '✗', pending: '…' } as const;

/** Итог уровня одной строкой: исход, звёзды, цели. */
export function formatLevelStatus(status: LevelStatus): string {
  const outcome =
    status.outcome === 'defeated' && status.defeat
      ? `провал на ходу ${status.defeat.turn}: ${status.defeat.reason}${status.defeat.reason === 'famine' ? ` (${status.defeat.province})` : ''}`
      : status.outcome === 'completed'
        ? 'пройден'
        : `не закончен (ход ${status.turn})`;
  const goals = status.goals.map((g) => `${GOAL_MARK[g.state]}${g.id}${g.value !== undefined ? `=${Number(g.value.toFixed(3))}` : ''}`).join(' ');
  return `${outcome}, ${STAR_MARK(status.stars)}; цели: ${goals}`;
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
    .map((line) =>
      line
        .map((cell, i) => (i === line.length - 1 ? cell : cell.padStart(widths[i]!)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatCsv(rows: readonly Row[]): string {
  return [COLUMNS.map((c) => c.title).join(','), ...rows.map((r) => COLUMNS.map((c) => c.value(r)).join(','))].join('\n');
}

/** Итоги разных ботов рядом: чтобы видеть, что у разных стратегий разные исходы. */
export function formatComparison(results: Record<string, Simulation>): string {
  const withLevel = Object.values(results).some((r) => r.level);
  const summary = Object.entries(results).map(([policy, { rows, level }]) => {
    const last = rows.at(-1)!;
    const maxUnemployment = Math.max(...rows.map((r) => r.unemployment));
    const maxShortage = Math.max(...rows.map((r) => Math.max(0, ...Object.values(r.maxShortage))));
    const cells = [policy, fix(last.cpi), pct(last.unemployment), pct(maxUnemployment), pct(maxShortage), fix(last.debt, 0), String(last.firms)];
    if (withLevel) cells.push(level?.outcome === 'defeated' ? `✗ ход ${level.defeat?.turn}` : STAR_MARK(level?.stars ?? 0));
    return cells;
  });
  const header = ['бот', 'ИПЦ итог', 'безр% итог', 'безр% макс', 'дефицит% макс', 'долг', 'фирм', ...(withLevel ? ['уровень'] : [])];
  const cells = [header, ...summary];
  const widths = header.map((_, i) => Math.max(...cells.map((line) => line[i]!.length)));
  return cells.map((line) => line.map((cell, i) => cell.padStart(widths[i]!)).join('  ')).join('\n');
}

export function main(argv: readonly string[]): string {
  const options = parseArgs(argv);
  const names = options.policy === 'all' ? policyNames : [options.policy];
  const results: Record<string, Simulation> = {};
  for (const name of names) results[name] = simulate({ ...options, policy: name });
  if (options.format === 'json') {
    const json = (r: Simulation) => (r.level ? { rows: r.rows, level: r.level } : r.rows);
    return JSON.stringify(options.policy === 'all' ? Object.fromEntries(names.map((n) => [n, json(results[n]!)])) : json(results[options.policy]!), null, 1);
  }
  const format = options.format === 'csv' ? formatCsv : formatTable;
  const title = options.level !== undefined ? `уровень ${options.level} (${options.scenario})` : options.scenario;
  const parts = names.map((name) => {
    const r = results[name]!;
    const status = r.level ? `\n# итог уровня: ${formatLevelStatus(r.level)}` : '';
    return `# ${title}, seed ${options.seed}, бот ${name}, ${options.turns} ходов\n${format(r.rows)}${status}`;
  });
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
