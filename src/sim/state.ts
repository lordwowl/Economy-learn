// Типы состояния мира. Состояние — простые данные (JSON-сериализуемо): сохранения и golden-тесты.

import type { Breakdown } from './causes';
import type { DelayQueue } from './delay';

export type GoodId = string;

export interface Firm {
  id: string;
  building: string;
  recipe: string;
  owner: 'private' | 'state';
  province: string;
  /** Максимум запусков рецепта за ход. */
  capacity: number;
  /** Запасы: выход и входы. */
  inventory: Record<GoodId, number>;
  cash: number;
  /** Цена выхода, назначенная на этот ход. */
  price: number;
  /** Разложение цены: input.<товар>, wage, markup, expectations. Σ = price. */
  breakdown: Breakdown;
  markup: number;
  /** Заказы за последние ходы (продажи + доля неудовлетворённого спроса), последний — в конце. */
  ordersHistory: number[];
  lastRuns: number;
  lastSales: number;
  lastProfit: number;
  lossTurns: number;
}

export interface Households {
  population: number;
  laborForce: number;
  cash: number;
}

export interface Province {
  id: string;
  nameKey: string;
  households: Households;
}

export interface MarketGood {
  /** Средняя цена сделок за последний ход. */
  price: number;
  /** Разложение средней цены (взвешено по продажам). Σ = price. */
  breakdown: Breakdown;
  /** P_ref: стартовая цена, опорная для спроса и базы ИПЦ. */
  referencePrice: number;
}

export type PendingEffect = { type: 'demandRate'; delta: number };

export interface Metrics {
  cpi: number;
  inflationMoM: number;
  inflationYoY: number | null;
  unemployment: number;
  employment: number;
  wage: number;
  realWage: number;
  householdSpending: number;
  output: Record<GoodId, number>;
  householdDemand: Record<GoodId, number>;
  householdPurchases: Record<GoodId, number>;
  /** Доля неудовлетворённого спроса домохозяйств. */
  shortage: Record<GoodId, number>;
}

export interface WorldState {
  /** Сколько ходов уже сыграно. */
  turn: number;
  wage: number;
  /** Объявленная ключевая ставка (годовая). */
  keyRate: number;
  /** Ставка, на которую уже отреагировали домохозяйства (догоняет keyRate с лагом). */
  demandRate: number;
  /** B_ref: стартовые траты домохозяйств на душу. */
  referenceSpendingPerCapita: number;
  provinces: Province[];
  firms: Firm[];
  market: Record<GoodId, MarketGood>;
  government: { cash: number };
  expectations: {
    /** π_a, месячная. */
    adaptive: number;
    /** π_e, месячная. */
    expected: number;
    /** Доверие к ЦБ C. */
    trust: number;
  };
  pending: DelayQueue<PendingEffect>;
  /** ИПЦ за последние 13 ходов (для г/г), последний — текущий. */
  cpiHistory: number[];
  metrics: Metrics;
}

export type Action = { type: 'setKeyRate'; rate: number };
