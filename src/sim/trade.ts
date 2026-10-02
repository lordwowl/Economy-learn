// Торговля по провинциям (GDD 5.16, 5.17).
// Сначала покупатели берут местное (рынок провинции), затем нехватку довозят из других провинций
// по кратчайшему пути. Цена доставленного = средняя цена продавцов провинции-источника + тариф.
// Перевозчик тратит своё топливо и нанимает труд; не влезшее в дороги остаётся у продавцов («очередь»).
// Пропускная способность дорог делится между рынком входов и потребительским рынком пропорционально
// заявкам прошлого хода; внутри рынка все товары планируются вместе и при пробке урезаются одинаково.

import type { GameData } from '../data/load';
import type { Recipe } from '../data/schemas';
import type { Breakdown } from './causes';
import { clearMarket, type Bid, type Offer } from './market';
import type { Firm, GoodId, TradePhase, WorldState } from './state';
import {
  fuelPerUnit,
  laborPerUnit,
  planShipments,
  routeCapacity,
  shortestPaths,
  tariff,
  type GoodBalance,
  type Path,
} from './systems/logistics';
import { COMPONENT } from './systems/pricing';

export interface TradeBid extends Bid {
  province: string;
}

export interface TradeOutcome {
  bought: Map<string, number>;
  paid: Map<string, number>;
  demandedByProvince: Record<string, number>;
  /** Неудовлетворённое из-за нехватки товара или дорог (не из-за бюджета). */
  unmetByProvince: Record<string, number>;
}

/** Сделки в провинции за ход: Σ количества и Σ количества × компоненты цены. */
interface Tally {
  quantity: number;
  weighted: Breakdown;
}

export class Trade {
  readonly soldByFirm = new Map<string, number>();
  readonly revenue = new Map<string, number>();
  readonly spent = new Map<string, number>();
  /** tallies[товар][провинция]. */
  readonly tallies: Record<GoodId, Record<string, Tally>> = {};
  readonly unmetByGood: Record<GoodId, number> = {};
  readonly routeFlow: Record<string, number> = {};
  readonly routeBlocked: Record<string, number> = {};
  readonly requested: Record<TradePhase, Record<string, number>> = { inputs: {}, consumer: {} };
  /** Заявленная работа (до ограничений дорог и ресурсов): по ней перевозчик планирует топливо. */
  requestedWork = 0;
  work = 0;
  logisticsLabor = 0;
  /** Зарплата, которую перевозчик заплатил за ход (её получают домохозяйства). */
  logisticsWages = 0;
  laborLeft: number;

  private readonly paths: Map<string, Path>;
  private readonly capacity: Record<string, number> = {};
  private readonly capacityLeft: Record<string, number> = {};
  private readonly firmsByGood = new Map<GoodId, Firm[]>();
  private readonly fuelPrice: number;

  constructor(
    private readonly state: WorldState,
    private readonly data: GameData,
    recipeOf: (firm: Firm) => Recipe,
    laborLeft: number,
  ) {
    this.laborLeft = laborLeft;
    this.paths = shortestPaths(
      state.provinces.map((p) => p.id),
      state.routes,
    );
    const lane = data.buildings.find((b) => b.kind === 'route');
    for (const route of state.routes) {
      this.capacity[route.id] = lane?.kind === 'route' ? routeCapacity(route, lane.capacityPerLane) : 0;
      this.capacityLeft[route.id] = this.capacity[route.id]!;
      this.routeFlow[route.id] = 0;
      this.routeBlocked[route.id] = 0;
    }
    for (const firm of state.firms) {
      const good = recipeOf(firm).output.good;
      const list = this.firmsByGood.get(good) ?? [];
      list.push(firm);
      this.firmsByGood.set(good, list);
    }
    this.fuelPrice = state.market[data.balance.logistics.fuelGood]?.price ?? 0;
  }

  tariffFor(path: Path): number {
    return tariff(path, this.fuelPrice, this.state.wage, this.data.balance.logistics);
  }

  /** Перевозчик докупает топливо у всех НПЗ страны (заправляется там, где стоят машины). */
  buyLogisticsFuel(quantity: number): void {
    const good = this.data.balance.logistics.fuelGood;
    const sellers = this.firmsByGood.get(good) ?? [];
    const logistics = this.state.logistics;
    const result = clearMarket(this.offers(sellers, good), [{ buyer: 'logistics', quantity, budget: logistics.cash }]);
    for (const firm of sellers) this.sell(firm, good, result.sold.get(firm.id) ?? 0, firm.province, 0);
    logistics.fuel += result.bought.get('logistics') ?? 0;
    logistics.cash -= result.paid.get('logistics') ?? 0;
  }

  /** Сколько пропускной способности дорог доступно фазе: доля по заявкам прошлого хода, остаток — следующей фазе. */
  private phaseCapacity(phase: TradePhase): Record<string, number> {
    if (phase === 'consumer') return { ...this.capacityLeft };
    const last = this.state.logistics.requested;
    const result: Record<string, number> = {};
    for (const [route, left] of Object.entries(this.capacityLeft)) {
      const mine = last.inputs[route] ?? 0;
      const total = mine + (last.consumer[route] ?? 0);
      result[route] = total > 0 ? Math.min(left, ((this.capacity[route] ?? 0) * mine) / total) : left;
    }
    return result;
  }

  tradePhase(phase: TradePhase, bidsByGood: ReadonlyMap<GoodId, readonly TradeBid[]>): Map<GoodId, TradeOutcome> {
    const cfg = this.data.balance.logistics;
    const outcomes = new Map<GoodId, TradeOutcome>();
    const remaining = new Map<GoodId, Map<string, TradeBid[]>>();
    const balances: GoodBalance[] = [];

    // 1. Местные рынки.
    for (const [good, bids] of bidsByGood) {
      const sellers = this.firmsByGood.get(good) ?? [];
      const outcome: TradeOutcome = { bought: new Map(), paid: new Map(), demandedByProvince: {}, unmetByProvince: {} };
      const rest = new Map<string, TradeBid[]>();
      for (const province of this.state.provinces) {
        const local = bids.filter((b) => b.province === province.id);
        if (local.length === 0) continue;
        const localSellers = sellers.filter((f) => f.province === province.id);
        const result = clearMarket(this.offers(localSellers, good), local);
        for (const firm of localSellers) this.sell(firm, good, result.sold.get(firm.id) ?? 0, province.id, 0);
        const fill = result.demanded > 0 ? (result.demanded - result.unmetBySupply) / result.demanded : 0;
        const left: TradeBid[] = [];
        for (const bid of local) {
          const pay = result.paid.get(bid.buyer) ?? 0;
          add(outcome.bought, bid.buyer, result.bought.get(bid.buyer) ?? 0);
          add(outcome.paid, bid.buyer, pay);
          const wanted = Math.max(0, bid.quantity) * (1 - fill);
          if (wanted > 0 && bid.budget - pay > 0) left.push({ ...bid, quantity: wanted, budget: bid.budget - pay });
        }
        outcome.demandedByProvince[province.id] = result.demanded;
        outcome.unmetByProvince[province.id] = result.unmetBySupply;
        rest.set(province.id, left);
      }
      outcomes.set(good, outcome);
      remaining.set(good, rest);
      const deficits: Record<string, number> = {};
      for (const [province, left] of rest) deficits[province] = left.reduce((s, b) => s + b.quantity, 0);
      const stocks: Record<string, number> = {};
      for (const firm of sellers) stocks[firm.province] = (stocks[firm.province] ?? 0) + (firm.inventory[good] ?? 0);
      balances.push({ good, deficits, stocks });
    }

    // 2. Довоз: план перевозок всех товаров фазы вместе.
    const shipments = planShipments(
      balances,
      this.paths,
      { capacityLeft: this.phaseCapacity(phase), fuel: this.state.logistics.fuel, labor: this.laborLeft },
      cfg,
    );
    for (const s of shipments) {
      this.requestedWork += s.requested * s.path.length;
      for (const e of s.path.edges) this.requested[phase][e] = (this.requested[phase][e] ?? 0) + s.requested;
      for (const e of s.bottlenecks) this.routeBlocked[e] = (this.routeBlocked[e] ?? 0) + s.blockedByRoad;
    }

    for (const [good, rest] of remaining) {
      const sellers = this.firmsByGood.get(good) ?? [];
      const outcome = outcomes.get(good)!;
      for (const [province, left] of rest) {
        const incoming = shipments.filter((s) => s.good === good && s.to === province && s.quantity > 0);
        if (incoming.length === 0 || left.length === 0) continue;
        const offers: Offer[] = incoming.map((s) => {
          const from = sellers.filter((f) => f.province === s.from);
          const stock = from.reduce((sum, f) => sum + (f.inventory[good] ?? 0), 0);
          const value = from.reduce((sum, f) => sum + (f.inventory[good] ?? 0) * f.price, 0);
          return { seller: s.from, price: (stock > 0 ? value / stock : 0) + this.tariffFor(s.path), quantity: s.quantity };
        });
        const result = clearMarket(offers, left);
        for (const s of incoming) this.ship(good, s.from, s.path, result.sold.get(s.from) ?? 0, sellers, province);
        for (const bid of left) {
          const got = result.bought.get(bid.buyer) ?? 0;
          add(outcome.bought, bid.buyer, got);
          add(outcome.paid, bid.buyer, result.paid.get(bid.buyer) ?? 0);
          outcome.unmetByProvince[province] = Math.max(0, (outcome.unmetByProvince[province] ?? 0) - got);
        }
      }
      for (const v of Object.values(outcome.unmetByProvince)) this.unmetByGood[good] = (this.unmetByGood[good] ?? 0) + v;
    }
    return outcomes;
  }

  private offers(firms: readonly Firm[], good: GoodId): Offer[] {
    return firms.map((f) => ({ seller: f.id, price: f.price, quantity: f.inventory[good] ?? 0 }));
  }

  /** Продажа фирмы: склад, деньги, учёт сделки в провинции покупателя (с доставкой, если она была). */
  private sell(firm: Firm, good: GoodId, quantity: number, province: string, delivery: number): void {
    if (quantity <= 0) return;
    firm.inventory[good] = (firm.inventory[good] ?? 0) - quantity;
    firm.cash += quantity * firm.price;
    add(this.soldByFirm, firm.id, quantity);
    add(this.revenue, firm.id, quantity * firm.price);
    const byProvince = (this.tallies[good] ??= {});
    const tally = (byProvince[province] ??= { quantity: 0, weighted: {} });
    tally.quantity += quantity;
    for (const [ref, v] of Object.entries(firm.breakdown)) tally.weighted[ref] = (tally.weighted[ref] ?? 0) + quantity * v;
    if (delivery !== 0) tally.weighted[COMPONENT.logistics] = (tally.weighted[COMPONENT.logistics] ?? 0) + quantity * delivery;
  }

  /** Перевозка: продавцы провинции-источника отгружают пропорционально складу, перевозчик тратит топливо и труд. */
  private ship(good: GoodId, fromProvince: string, path: Path, shipped: number, sellers: readonly Firm[], to: string): void {
    if (shipped <= 0) return;
    const cfg = this.data.balance.logistics;
    const from = sellers.filter((f) => f.province === fromProvince);
    const stock = from.reduce((sum, f) => sum + (f.inventory[good] ?? 0), 0);
    const delivery = this.tariffFor(path);
    if (stock > 0) for (const firm of from) this.sell(firm, good, (shipped * (firm.inventory[good] ?? 0)) / stock, to, delivery);
    const logistics = this.state.logistics;
    const labor = shipped * laborPerUnit(path, cfg);
    const wages = labor * this.state.wage;
    logistics.cash += shipped * delivery - wages;
    logistics.fuel = Math.max(0, logistics.fuel - shipped * fuelPerUnit(path, cfg));
    this.logisticsWages += wages;
    this.logisticsLabor += labor;
    this.laborLeft -= labor;
    this.work += shipped * path.length;
    for (const e of path.edges) {
      this.capacityLeft[e] = (this.capacityLeft[e] ?? 0) - shipped;
      this.routeFlow[e] = (this.routeFlow[e] ?? 0) + shipped;
    }
  }
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}
