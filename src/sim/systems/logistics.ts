// Логистика (GDD 5.2, 5.17): кратчайшие пути, тариф перевозки, распределение перевозок по узким местам.

import type { Balance } from '../../data/schemas';
import type { Route } from '../state';

export interface Path {
  from: string;
  to: string;
  /** Суммарная длина рёбер. */
  length: number;
  /** id дорог по порядку. */
  edges: string[];
}

export const pairKey = (from: string, to: string) => `${from}>${to}`;

export function routeCapacity(route: Route, capacityPerLane: number): number {
  return route.lanes * capacityPerLane;
}

/** Кратчайшие пути по проезжим дорогам (lanes > 0), Флойд — Уоршелл. Порядок обхода фиксирован — результат детерминирован. */
export function shortestPaths(provinces: readonly string[], routes: readonly Route[]): Map<string, Path> {
  const dist = new Map<string, number>();
  const via = new Map<string, { next: string; edges: string[] }>();
  for (const route of routes) {
    if (route.lanes <= 0) continue;
    for (const [from, to] of [
      [route.a, route.b],
      [route.b, route.a],
    ] as const) {
      const key = pairKey(from, to);
      if ((dist.get(key) ?? Infinity) > route.length) {
        dist.set(key, route.length);
        via.set(key, { next: to, edges: [route.id] });
      }
    }
  }
  for (const k of provinces) {
    for (const i of provinces) {
      for (const j of provinces) {
        if (i === j) continue;
        const ik = dist.get(pairKey(i, k));
        const kj = dist.get(pairKey(k, j));
        if (ik === undefined || kj === undefined) continue;
        if (ik + kj < (dist.get(pairKey(i, j)) ?? Infinity)) {
          dist.set(pairKey(i, j), ik + kj);
          via.set(pairKey(i, j), { next: k, edges: [...via.get(pairKey(i, k))!.edges, ...via.get(pairKey(k, j))!.edges] });
        }
      }
    }
  }
  const paths = new Map<string, Path>();
  for (const [key, length] of dist) {
    const [from, to] = key.split('>') as [string, string];
    if (from === to) continue;
    paths.set(key, { from, to, length, edges: via.get(key)!.edges });
  }
  return paths;
}

/** Топливо на 1 ед. груза по пути. */
export function fuelPerUnit(path: Path, logistics: Balance['logistics']): number {
  return logistics.fuelPerUnitLength * path.length;
}

/** Труд на 1 ед. груза по пути. */
export function laborPerUnit(path: Path, logistics: Balance['logistics']): number {
  return logistics.laborPerUnit * path.edges.length;
}

/** Тариф за 1 ед. груза: (топливо × цена топлива + труд × зарплата) × (1 + наценка перевозчика). */
export function tariff(path: Path, fuelPrice: number, wage: number, logistics: Balance['logistics']): number {
  return (fuelPerUnit(path, logistics) * fuelPrice + laborPerUnit(path, logistics) * wage) * (1 + logistics.markup);
}

export interface Shipment {
  good: string;
  from: string;
  to: string;
  path: Path;
  /** Сколько хотели везти (после ограничения запасом продавцов). */
  requested: number;
  /** Сколько можно везти с учётом дорог, топлива и труда. */
  quantity: number;
  /** Сколько не влезло в дороги (очередь узкого места). */
  blockedByRoad: number;
  /** Дороги, которые ограничили эту перевозку. */
  bottlenecks: string[];
}

export interface ShipmentLimits {
  /** Сколько пропускной способности дорог доступно этим перевозкам. */
  capacityLeft: Record<string, number>;
  fuel: number;
  labor: number;
}

export interface GoodBalance {
  good: string;
  /** Нехватка по провинциям. */
  deficits: Record<string, number>;
  /** Остатки у продавцов по провинциям. */
  stocks: Record<string, number>;
}

/**
 * Делит нехватку провинций между провинциями с остатками, все товары — вместе:
 *  1) заявка p к q пропорциональна остатку q среди достижимых из p;
 *  2) если у q просят больше, чем есть, — пропорционально урезается;
 *  3) если по дороге хотят провезти больше её остатка — урезаются все перевозки через неё, всех товаров;
 *  4) если не хватает топлива или труда перевозчика — урезаются все перевозки.
 * Один проход: результат всегда допустим (не нарушает ни одного ограничения), хотя не всегда максимален.
 */
export function planShipments(
  balances: readonly GoodBalance[],
  paths: Map<string, Path>,
  limits: ShipmentLimits,
  logistics: Balance['logistics'],
): Shipment[] {
  const shipments: Shipment[] = [];
  for (const { good, deficits, stocks } of balances) {
    const own: Shipment[] = [];
    for (const [to, need] of Object.entries(deficits)) {
      if (need <= 0) continue;
      const reachable = Object.entries(stocks).filter(([from, stock]) => from !== to && stock > 0 && paths.has(pairKey(from, to)));
      const total = reachable.reduce((sum, [, stock]) => sum + stock, 0);
      for (const [from, stock] of reachable) {
        const requested = (need * stock) / total;
        own.push({ good, from, to, path: paths.get(pairKey(from, to))!, requested, quantity: requested, blockedByRoad: 0, bottlenecks: [] });
      }
    }
    const askedFrom: Record<string, number> = {};
    for (const s of own) askedFrom[s.from] = (askedFrom[s.from] ?? 0) + s.quantity;
    for (const s of own) {
      const asked = askedFrom[s.from] ?? 0;
      const stock = stocks[s.from] ?? 0;
      if (asked > stock) s.quantity *= stock / asked;
      s.requested = s.quantity;
    }
    shipments.push(...own.filter((s) => s.requested > 0));
  }

  const load: Record<string, number> = {};
  for (const s of shipments) for (const e of s.path.edges) load[e] = (load[e] ?? 0) + s.quantity;
  for (const s of shipments) {
    let factor = 1;
    for (const e of s.path.edges) {
      const l = load[e] ?? 0;
      const cap = Math.max(0, limits.capacityLeft[e] ?? 0);
      if (l > cap) {
        factor = Math.min(factor, cap / l);
        s.bottlenecks.push(e);
      }
    }
    s.blockedByRoad = s.quantity * (1 - factor);
    s.quantity *= factor;
  }

  let fuel = 0;
  let labor = 0;
  for (const s of shipments) {
    fuel += s.quantity * fuelPerUnit(s.path, logistics);
    labor += s.quantity * laborPerUnit(s.path, logistics);
  }
  const resourceFactor = Math.min(1, fuel > 0 ? Math.max(0, limits.fuel) / fuel : 1, labor > 0 ? Math.max(0, limits.labor) / labor : 1);
  if (resourceFactor < 1) for (const s of shipments) s.quantity *= resourceFactor;

  return shipments;
}
