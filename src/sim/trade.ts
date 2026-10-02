// Торговля по провинциям (GDD 5.16, 5.17).
// Сначала покупатели берут местное (рынок провинции), затем нехватку довозят из других провинций
// по кратчайшему пути. Цена доставленного = средняя цена продавцов провинции-источника + тариф.
// Возят перевозчики: сначала тот, у кого тариф ниже (госпарк без наценки), остальное — частный.
// Каждый тратит своё топливо и нанимает труд; работа ограничена парком; не влезшее в дороги
// остаётся у продавцов («очередь»).
// Пропускная способность участков (дорога в одну сторону) делится между рынком входов и потребительским рынком пропорционально
// заявкам прошлого хода; внутри рынка все товары планируются вместе и при пробке урезаются одинаково.

import type { GameData } from '../data/load';
import type { Recipe } from '../data/schemas';
import type { Breakdown } from './causes';
import { clearMarket, type Bid, type Offer } from './market';
import type { Carrier, CarrierId, Firm, GoodId, TradePhase, WorldState } from './state';
import { addRevenue, addSpending, BUDGET } from './systems/government';
import {
  fuelPerUnit,
  laborPerUnit,
  legKey,
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

/** Продавец «госрезерв» в местной торговле. */
export const RESERVE_SELLER = 'reserve';

/** Сделки в провинции за ход: Σ количества и Σ количества × компоненты цены. */
interface Tally {
  quantity: number;
  weighted: Breakdown;
}

/** Итоги перевозчика за ход. */
export interface CarrierTurn {
  /** Работа, которую ему поручили (с учётом не влезшего в парк — для частного). */
  requestedWork: number;
  work: number;
  labor: number;
  wages: number;
  revenue: number;
  fuelCost: number;
}

/** Доли перевозчиков в одной перевозке. */
type CarrierMix = { carrier: Carrier; share: number }[];

export class Trade {
  readonly soldByFirm = new Map<string, number>();
  readonly revenue = new Map<string, number>();
  readonly spent = new Map<string, number>();
  /** Субсидии, полученные фирмами (входят в прибыль, но не в ВВП). */
  readonly subsidyReceived = new Map<string, number>();
  /** Покупки входов фирмами (для ВВП). */
  readonly inputSpent = new Map<string, number>();
  /** tallies[товар][провинция]. */
  readonly tallies: Record<GoodId, Record<string, Tally>> = {};
  readonly unmetByGood: Record<GoodId, number> = {};
  /** Поток и очередь по участкам (legKey). */
  readonly legFlow: Record<string, number> = {};
  readonly legBlocked: Record<string, number> = {};
  readonly requested: Record<TradePhase, Record<string, number>> = { inputs: {}, consumer: {} };
  readonly carriers: Record<CarrierId, CarrierTurn> = {
    private: { requestedWork: 0, work: 0, labor: 0, wages: 0, revenue: 0, fuelCost: 0 },
    state: { requestedWork: 0, work: 0, labor: 0, wages: 0, revenue: 0, fuelCost: 0 },
  };
  /** Продано из резерва за ход: [товар][провинция]. */
  readonly reserveSold: Record<GoodId, Record<string, number>> = {};
  laborLeft: number;

  private readonly paths: Map<string, Path>;
  private readonly capacity: Record<string, number> = {};
  private readonly capacityLeft: Record<string, number> = {};
  private readonly firmsByGood = new Map<GoodId, Firm[]>();
  private readonly fuelPrice: number;
  /** Сколько работы ещё может сделать перевозчик за ход (парк). */
  private readonly workLeft: Record<CarrierId, number> = { private: 0, state: 0 };
  /** Топливо, зарезервированное под запланированные, но ещё не выполненные перевозки. */
  private readonly fuelReserved: Record<CarrierId, number> = { private: 0, state: 0 };
  /** Интервенции этого хода: reserveOffers[товар][провинция] = { осталось продать, цена }. */
  private readonly reserveOffers: Record<GoodId, Record<string, { quantity: number; price: number }>> = {};

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
      for (const to of [route.a, route.b]) {
        const leg = legKey(route.id, to);
        this.capacity[leg] = lane?.kind === 'route' ? routeCapacity(route, lane.capacityPerLane) : 0;
        this.capacityLeft[leg] = this.capacity[leg]!;
        this.legFlow[leg] = 0;
        this.legBlocked[leg] = 0;
      }
    }
    for (const firm of state.firms) {
      const good = recipeOf(firm).output.good;
      const list = this.firmsByGood.get(good) ?? [];
      list.push(firm);
      this.firmsByGood.set(good, list);
    }
    this.fuelPrice = state.market[data.balance.logistics.fuelGood]?.price ?? 0;
    const fleet = data.buildings.find((b) => b.kind === 'fleet');
    for (const c of state.logistics.carriers) this.workLeft[c.id] = fleet?.kind === 'fleet' ? c.fleet * fleet.workCapacity : 0;
  }

  /** Перевозчики в порядке выбора: дешёвые первыми. */
  private get carrierOrder(): Carrier[] {
    return [...this.state.logistics.carriers].sort((a, b) => a.markup - b.markup || a.id.localeCompare(b.id));
  }

  /** Сколько работы перевозчик может сделать прямо сейчас: остаток парка и топливо. */
  private room(carrier: Carrier): number {
    const perWork = this.data.balance.logistics.fuelPerUnitLength;
    const byFuel = perWork > 0 ? Math.max(0, carrier.fuel - this.fuelReserved[carrier.id]) / perWork : Infinity;
    return Math.max(0, Math.min(this.workLeft[carrier.id], byFuel));
  }

  tariffFor(path: Path, markup: number): number {
    return tariff(path, this.fuelPrice, this.state.wage, this.data.balance.logistics, markup);
  }

  /** Перевозчик докупает топливо у всех НПЗ страны. Госперевозчику платит бюджет (касса может уйти в минус до конца хода). */
  buyCarrierFuel(carrier: Carrier, quantity: number): void {
    if (quantity <= 0) return;
    const good = this.data.balance.logistics.fuelGood;
    const sellers = this.firmsByGood.get(good) ?? [];
    const buyer = `carrier.${carrier.id}`;
    const budget = carrier.id === 'state' ? Infinity : Math.max(0, carrier.cash);
    const result = clearMarket(this.offers(sellers, good), [{ buyer, quantity, budget }]);
    for (const firm of sellers) this.sell(firm, good, result.sold.get(firm.id) ?? 0, firm.province, 0);
    carrier.fuel += result.bought.get(buyer) ?? 0;
    const paid = result.paid.get(buyer) ?? 0;
    carrier.cash -= paid;
    this.carriers[carrier.id].fuelCost += paid;
  }

  /** Интервенция: резерв продаёт товар на местном рынке провинции (в обеих фазах, пока не продаст). */
  offerFromReserve(good: GoodId, province: string, quantity: number, price: number): void {
    if (quantity <= 0) return;
    const byProvince = (this.reserveOffers[good] ??= {});
    byProvince[province] = { quantity: (byProvince[province]?.quantity ?? 0) + quantity, price };
  }

  /** Сколько пропускной способности дорог доступно фазе: доля по заявкам прошлого хода, остаток — следующей фазе. */
  private phaseCapacity(phase: TradePhase): Record<string, number> {
    if (phase === 'consumer') return { ...this.capacityLeft };
    const last = this.state.logistics.requested;
    const result: Record<string, number> = {};
    for (const [leg, left] of Object.entries(this.capacityLeft)) {
      const mine = last.inputs[leg] ?? 0;
      const total = mine + (last.consumer[leg] ?? 0);
      result[leg] = total > 0 ? Math.min(left, ((this.capacity[leg] ?? 0) * mine) / total) : left;
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
        const reserve = this.reserveOffers[good]?.[province.id];
        const offers = this.offers(localSellers, good);
        if (reserve) offers.push({ seller: RESERVE_SELLER, price: reserve.price, quantity: reserve.quantity });
        const result = clearMarket(offers, local);
        for (const firm of localSellers) this.sell(firm, good, result.sold.get(firm.id) ?? 0, province.id, 0);
        if (reserve) this.sellFromReserve(good, province.id, result.sold.get(RESERVE_SELLER) ?? 0, reserve);
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

    // 2. Довоз: план перевозок всех товаров фазы вместе; работа ограничена парком и топливом перевозчиков.
    const carriers = this.carrierOrder;
    const shipments = planShipments(
      balances,
      this.paths,
      {
        capacityLeft: this.phaseCapacity(phase),
        work: carriers.reduce((s, c) => s + this.room(c), 0),
        labor: this.laborLeft,
      },
      cfg,
    );
    const mixes = new Map<(typeof shipments)[number], CarrierMix>();
    const room = carriers.reduce((s, c) => s + this.room(c), 0);
    let wanted = 0;
    for (const s of shipments) {
      wanted += (s.requested - s.blockedByRoad) * s.path.length;
      for (const e of s.path.edges) this.requested[phase][e] = (this.requested[phase][e] ?? 0) + s.requested;
      for (const e of s.bottlenecks) this.legBlocked[e] = (this.legBlocked[e] ?? 0) + s.blockedByRoad;
      // Распределение работы между перевозчиками: дешёвые первыми, в пределах парка и топлива.
      let work = s.quantity * s.path.length;
      const mix: CarrierMix = [];
      for (const c of carriers) {
        const take = Math.min(work, this.room(c));
        if (take <= 0) continue;
        this.workLeft[c.id] -= take;
        this.fuelReserved[c.id] += take * cfg.fuelPerUnitLength;
        this.carriers[c.id].requestedWork += take;
        mix.push({ carrier: c, share: take / (s.quantity * s.path.length) });
        work -= take;
      }
      mixes.set(s, mix);
    }
    // Работу, на которую не хватило парка и топлива, видит частный перевозчик: это сигнал расширять парк.
    this.carriers.private.requestedWork += Math.max(0, wanted - room);

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
          return { seller: s.from, price: (stock > 0 ? value / stock : 0) + this.mixTariff(s.path, mixes.get(s)!), quantity: s.quantity };
        });
        const result = clearMarket(offers, left);
        for (const s of incoming) this.ship(good, s.from, s.path, s.quantity, result.sold.get(s.from) ?? 0, mixes.get(s)!, sellers, province);
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

  private mixTariff(path: Path, mix: CarrierMix): number {
    let t = 0;
    for (const { carrier, share } of mix) t += share * this.tariffFor(path, carrier.markup);
    return t;
  }

  private offers(firms: readonly Firm[], good: GoodId): Offer[] {
    return firms.map((f) => ({ seller: f.id, price: f.price, quantity: f.inventory[good] ?? 0 }));
  }

  /** Продажа фирмы: склад, деньги, налог с продаж, учёт сделки в провинции покупателя (с доставкой, если она была). */
  private sell(firm: Firm, good: GoodId, quantity: number, province: string, delivery: number): void {
    if (quantity <= 0) return;
    firm.inventory[good] = (firm.inventory[good] ?? 0) - quantity;
    const value = quantity * firm.price;
    const tax = value * this.state.government.taxes.sales;
    firm.cash += value - tax;
    add(this.spent, firm.id, tax);
    addRevenue(this.state, BUDGET.salesTax, tax);
    const subsidy = quantity * (this.state.government.subsidies[good] ?? 0);
    if (subsidy > 0) {
      firm.cash += subsidy;
      add(this.subsidyReceived, firm.id, subsidy);
      addSpending(this.state, BUDGET.subsidies, subsidy);
    }
    add(this.soldByFirm, firm.id, quantity);
    add(this.revenue, firm.id, quantity * firm.price);
    const byProvince = (this.tallies[good] ??= {});
    const tally = (byProvince[province] ??= { quantity: 0, weighted: {} });
    tally.quantity += quantity;
    for (const [ref, v] of Object.entries(firm.breakdown)) tally.weighted[ref] = (tally.weighted[ref] ?? 0) + quantity * v;
    if (delivery !== 0) tally.weighted[COMPONENT.logistics] = (tally.weighted[COMPONENT.logistics] ?? 0) + quantity * delivery;
  }

  /** Продажа из резерва: деньги — в бюджет, в цене — компонента reserve. */
  private sellFromReserve(good: GoodId, province: string, quantity: number, offer: { quantity: number; price: number }): void {
    if (quantity <= 0) return;
    offer.quantity -= quantity;
    const sold = (this.reserveSold[good] ??= {});
    sold[province] = (sold[province] ?? 0) + quantity;
    const stock = (this.state.reserve.stock[province] ??= {});
    stock[good] = Math.max(0, (stock[good] ?? 0) - quantity);
    addRevenue(this.state, BUDGET.reserveSales, quantity * offer.price);
    const tally = ((this.tallies[good] ??= {})[province] ??= { quantity: 0, weighted: {} });
    tally.quantity += quantity;
    tally.weighted[COMPONENT.reserve] = (tally.weighted[COMPONENT.reserve] ?? 0) + quantity * offer.price;
  }

  /** Продажа «из-под полы»: товар уже отложен со склада, налога нет, премия к официальной цене — компонента blackMarket. */
  sellBlack(firm: Firm, good: GoodId, quantity: number, province: string, price: number): void {
    if (quantity <= 0) return;
    firm.cash += quantity * price;
    add(this.soldByFirm, firm.id, quantity);
    add(this.revenue, firm.id, quantity * price);
    const byProvince = (this.tallies[good] ??= {});
    const tally = (byProvince[province] ??= { quantity: 0, weighted: {} });
    tally.quantity += quantity;
    for (const [ref, v] of Object.entries(firm.breakdown)) tally.weighted[ref] = (tally.weighted[ref] ?? 0) + quantity * v;
    tally.weighted[COMPONENT.blackMarket] = (tally.weighted[COMPONENT.blackMarket] ?? 0) + quantity * (price - firm.price);
  }

  /**
   * Перевозка: продавцы провинции-источника отгружают пропорционально складу; перевозчики — по своим долям —
   * получают тариф, тратят топливо и труд. Неиспользованная часть зарезервированного парка возвращается.
   */
  private ship(
    good: GoodId,
    fromProvince: string,
    path: Path,
    planned: number,
    shipped: number,
    mix: CarrierMix,
    sellers: readonly Firm[],
    to: string,
  ): void {
    const cfg = this.data.balance.logistics;
    for (const { carrier, share } of mix) {
      this.workLeft[carrier.id] += (planned - shipped) * share * path.length;
      this.fuelReserved[carrier.id] -= planned * share * path.length * cfg.fuelPerUnitLength;
    }
    if (shipped <= 0) return;
    const from = sellers.filter((f) => f.province === fromProvince);
    const stock = from.reduce((sum, f) => sum + (f.inventory[good] ?? 0), 0);
    const delivery = this.mixTariff(path, mix);
    if (stock > 0) for (const firm of from) this.sell(firm, good, (shipped * (firm.inventory[good] ?? 0)) / stock, to, delivery);
    for (const { carrier, share } of mix) {
      const q = shipped * share;
      const turn = this.carriers[carrier.id];
      const labor = q * laborPerUnit(path, cfg);
      const wages = labor * this.state.wage;
      const revenue = q * this.tariffFor(path, carrier.markup);
      carrier.cash += revenue - wages;
      carrier.fuel = Math.max(0, carrier.fuel - q * fuelPerUnit(path, cfg));
      turn.revenue += revenue;
      turn.wages += wages;
      turn.labor += labor;
      turn.work += q * path.length;
      this.laborLeft -= labor;
    }
    for (const e of path.edges) {
      this.capacityLeft[e] = (this.capacityLeft[e] ?? 0) - shipped;
      this.legFlow[e] = (this.legFlow[e] ?? 0) + shipped;
    }
  }

  /** Сводно по всем перевозчикам. */
  get logisticsLabor(): number {
    return this.carriers.private.labor + this.carriers.state.labor;
  }
  get logisticsWages(): number {
    return this.carriers.private.wages + this.carriers.state.wages;
  }
  get work(): number {
    return this.carriers.private.work + this.carriers.state.work;
  }
  get logisticsRevenue(): number {
    return this.carriers.private.revenue + this.carriers.state.revenue;
  }
  get logisticsFuelCost(): number {
    return this.carriers.private.fuelCost + this.carriers.state.fuelCost;
  }
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}
