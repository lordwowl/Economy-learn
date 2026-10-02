// Модель карты: чистые функции без PixiJS (тестируются в Node). Рендер только читает состояние мира.

import type { Building, Scenario } from '../data/schemas';
import type { WorldState } from '../sim/state';

export type Point = readonly [number, number];
export type MapLayout = Scenario['map'];

// ---------- визуальные константы (не формулы модели) ----------

/** Пороги дефицита для уровней тепловой карты 1, 2, 3 (доля неудовлетворённого спроса). */
export const DEFICIT_THRESHOLDS = [0.05, 0.2, 0.5] as const;
export type DeficitLevel = 0 | 1 | 2 | 3;

/**
 * Палитра, безопасная для дальтоников (Okabe–Ito и последовательная шкала по светлоте).
 * Цвет всегда дублируется знаком: дефицит — «!», «!!», «!!!»; тренд цен — ▲ / ▼.
 */
export const COLORS = {
  background: 0xf4f1ea,
  provinceBorder: 0x5b6475,
  deficit: [0xdfe9d6, 0xf1cf72, 0xe08d3c, 0xb2452a] as const,
  road: 0x4a5160,
  plannedRoad: 0x9aa3b5,
  bottleneck: 0xb2452a,
  trendUp: 0xd55e00,
  trendDown: 0x0072b2,
  trendFlat: 0x7a7a7a,
  building: 0x1f3a5f,
  buildingConstruction: 0x9aa3b5,
  storage: 0x6b4f2a,
  text: 0x1d2330,
} as const;

/** Единиц груза за ход на одну бегущую точку и предел точек на направление (слабые устройства). */
export const UNITS_PER_DOT = 25;
export const MAX_DOTS_PER_DIRECTION = 16;
/** Порог «цены не изменились» для тренда, доля. */
export const TREND_EPSILON = 0.001;

// ---------- тепловая карта дефицита ----------

export function deficitLevel(shortage: number): DeficitLevel {
  if (shortage >= DEFICIT_THRESHOLDS[2]) return 3;
  if (shortage >= DEFICIT_THRESHOLDS[1]) return 2;
  if (shortage >= DEFICIT_THRESHOLDS[0]) return 1;
  return 0;
}

/** Дефицит провинции: наибольшая доля неудовлетворённого спроса населения по товарам. */
export function provinceDeficit(state: WorldState, province: string): number {
  return Math.max(0, ...Object.values(state.metrics.provinceShortage[province] ?? {}));
}

/** Знак, дублирующий цвет дефицита. */
export function deficitMark(level: DeficitLevel): string {
  return '!'.repeat(level);
}

// ---------- тренд цен ----------

export type Trend = 'up' | 'down' | 'flat';

/** Тренд цен в провинции за ход: средняя относительная перемена цен товаров. */
export function priceTrend(state: WorldState, prev: WorldState | undefined, province: string): Trend {
  if (!prev) return 'flat';
  let sum = 0;
  let n = 0;
  for (const [good, m] of Object.entries(state.market)) {
    const now = m.provinces[province]?.price;
    const before = prev.market[good]?.provinces[province]?.price;
    if (now === undefined || before === undefined || before <= 0) continue;
    sum += now / before - 1;
    n++;
  }
  const change = n > 0 ? sum / n : 0;
  if (change > TREND_EPSILON) return 'up';
  if (change < -TREND_EPSILON) return 'down';
  return 'flat';
}

export function trendColor(trend: Trend): number {
  return trend === 'up' ? COLORS.trendUp : trend === 'down' ? COLORS.trendDown : COLORS.trendFlat;
}

export function trendMark(trend: Trend): string {
  return trend === 'up' ? '▲' : trend === 'down' ? '▼' : '';
}

// ---------- здания ----------

export interface BuildingCluster {
  building: string;
  shape: Building['shape'];
  /** Работающих (достроенных) единиц. */
  ready: number;
  /** Строящихся. */
  underConstruction: number;
}

/** Здания провинции, сгруппированные по типу, в порядке buildings.json: фирмы и склады резерва. */
export function buildingClusters(state: WorldState, buildings: readonly Building[], province: string): BuildingCluster[] {
  const clusters: BuildingCluster[] = [];
  for (const b of buildings) {
    if (b.kind === 'producer') {
      const firms = state.firms.filter((f) => f.province === province && f.building === b.id);
      const construction = firms.filter((f) => f.underConstruction).length;
      if (firms.length > 0) clusters.push({ building: b.id, shape: b.shape, ready: firms.length - construction, underConstruction: construction });
    } else if (b.kind === 'storage') {
      const storages = state.reserve.storages.filter((s) => s.province === province && s.building === b.id);
      const construction = storages.filter((s) => !s.ready).length;
      if (storages.length > 0) clusters.push({ building: b.id, shape: b.shape, ready: storages.length - construction, underConstruction: construction });
    }
  }
  return clusters;
}

/** Смещения значков кластера вокруг центра провинции: сетка не шире `columns`. */
export function clusterOffsets(count: number, spacing: number, columns = 3): Point[] {
  const rows = Math.ceil(count / columns);
  const offsets: Point[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / columns);
    const inRow = Math.min(columns, count - row * columns);
    const col = i % columns;
    offsets.push([(col - (inRow - 1) / 2) * spacing, (row - (rows - 1) / 2) * spacing]);
  }
  return offsets;
}

// ---------- дороги и потоки ----------

/** Путь дороги на карте: узел a → изгибы → узел b. */
export function routePath(layout: MapLayout, route: { id: string; a: string; b: string }): Point[] {
  const a = layout.provinces[route.a]?.hub;
  const b = layout.provinces[route.b]?.hub;
  if (!a || !b) return [];
  return [a, ...(layout.routes[route.id]?.via ?? []), b];
}

export function pathLength(path: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
  return length;
}

/**
 * Точка на пути в доле t ∈ [0, 1] по длине, сдвинутая вбок на `side` (встречные потоки идут по разным сторонам).
 */
export function pointAt(path: readonly Point[], t: number, side = 0): Point {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0]!;
  let left = Math.min(1, Math.max(0, t)) * pathLength(path);
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1]!;
    const [x1, y1] = path[i]!;
    const seg = Math.hypot(x1 - x0, y1 - y0);
    if (left <= seg || i === path.length - 1) {
      const k = seg > 0 ? Math.min(1, left / seg) : 0;
      const nx = seg > 0 ? -(y1 - y0) / seg : 0;
      const ny = seg > 0 ? (x1 - x0) / seg : 0;
      return [x0 + (x1 - x0) * k + nx * side, y0 + (y1 - y0) * k + ny * side];
    }
    left -= seg;
  }
  return path[path.length - 1]!;
}

/** Сколько бегущих точек рисовать для потока. */
export function dotCount(flow: number): number {
  if (flow <= 0) return 0;
  return Math.min(MAX_DOTS_PER_DIRECTION, Math.ceil(flow / UNITS_PER_DOT));
}

// ---------- геометрия ----------

export type PathCommand = { type: 'move'; to: Point } | { type: 'quad'; control: Point; to: Point };

/** «Мягкий» полигон: кривые через середины сторон, вершины — контрольные точки. */
export function smoothPolygon(points: readonly Point[]): PathCommand[] {
  const n = points.length;
  if (n < 3) return [];
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const commands: PathCommand[] = [{ type: 'move', to: mid(points[n - 1]!, points[0]!) }];
  for (let i = 0; i < n; i++) commands.push({ type: 'quad', control: points[i]!, to: mid(points[i]!, points[(i + 1) % n]!) });
  return commands;
}

export interface Fit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Вписать раскладку в экран с полями, сохранив пропорции. */
export function fitToView(width: number, height: number, viewWidth: number, viewHeight: number, padding: number): Fit {
  const scale = Math.max(0, Math.min((viewWidth - 2 * padding) / width, (viewHeight - 2 * padding) / height));
  return { scale, offsetX: (viewWidth - width * scale) / 2, offsetY: (viewHeight - height * scale) / 2 };
}
