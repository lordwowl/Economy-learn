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
  /** Долг банку. */
  debt: number;
  /** Строится: мощность появится, когда созреет отложенный эффект firmReady. */
  underConstruction: boolean;
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
  /** B_ref: стартовые траты на душу в этой провинции. */
  referenceSpendingPerCapita: number;
}

export interface Province {
  id: string;
  nameKey: string;
  households: Households;
}

export interface ProvinceMarket {
  /** Средняя цена сделок в провинции за последний ход (с доставкой). */
  price: number;
  /** Разложение цены: компоненты продавцов + logistics. Σ = price. */
  breakdown: Breakdown;
  /** P_ref провинции: стартовая цена, опорная для спроса. */
  referencePrice: number;
  /** Сколько ходов подряд в провинции устойчивый дефицит товара (для входа новых фирм). */
  shortageTurns: number;
}

export interface MarketGood {
  /** Средняя по стране цена (провинции взвешены по населению). */
  price: number;
  /** Разложение средней цены. Σ = price. */
  breakdown: Breakdown;
  /** Стартовая средняя цена — база ИПЦ. */
  referencePrice: number;
  provinces: Record<string, ProvinceMarket>;
}

export interface Route {
  id: string;
  a: string;
  b: string;
  length: number;
  lanes: number;
}

/** Агрегированный частный перевозчик (GDD 5.17). */
export interface Logistics {
  cash: number;
  /** Запас топлива для перевозок. */
  fuel: number;
  /** Заявленная работа (груз × длина) за последние ходы, последняя — в конце. */
  workHistory: number[];
  lastWork: number;
  lastLabor: number;
  /** Заявки на перевозку за прошлый ход по участкам (дорога + направление), отдельно для рынка входов и потребительского. */
  requested: Record<TradePhase, Record<string, number>>;
}

export type TradePhase = 'inputs' | 'consumer';

export interface DirectionMetrics {
  from: string;
  to: string;
  /** Провезено за ход в этом направлении. */
  flow: number;
  /** Не провезено из-за этой дороги в этом направлении — «очередь» узкого места. */
  blocked: number;
}

export interface RouteMetrics {
  /** Пропускная способность в каждую сторону. */
  capacity: number;
  /** [a → b, b → a]. */
  directions: [DirectionMetrics, DirectionMetrics];
}

export type TaxKind = 'sales' | 'profit' | 'income';

export interface Government {
  /** Деньги на счёте. В конце хода дефицит закрывается займом, профицит гасит долг. */
  cash: number;
  debt: number;
  taxes: Record<TaxKind, number>;
  transfersPerCapita: number;
  /** Действующая субсидия производителю за единицу проданного товара (догоняет объявленную с лагом). */
  subsidies: Record<GoodId, number>;
  /** Объявленная игроком субсидия. */
  announcedSubsidies: Record<GoodId, number>;
  /** Доходы за прошлый ход по статьям: tax.sales, tax.profit, tax.income, stateFirms. */
  revenue: Breakdown;
  /** Расходы за прошлый ход по статьям: transfers, construction, interest, subsidies. */
  spending: Breakdown;
}

/** Банк: выдаёт кредиты (кредит создаёт деньги, погашение — уничтожает), проценты отдаёт владельцам-населению. */
export interface Bank {
  cash: number;
  /** Списанные безнадёжные долги, накопленно: учитываются в инварианте денег. */
  writtenOff: number;
}

export type PendingEffect =
  | { type: 'demandRate'; delta: number }
  | { type: 'creditRate'; delta: number }
  | { type: 'subsidy'; good: GoodId; delta: number }
  | { type: 'roadLane'; route: string }
  | { type: 'firmReady'; firm: string; capacity: number };

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
  /** Доля неудовлетворённого спроса домохозяйств по стране. */
  shortage: Record<GoodId, number>;
  /** То же по провинциям: provinceShortage[провинция][товар]. */
  provinceShortage: Record<string, Record<GoodId, number>>;
  routes: Record<string, RouteMetrics>;
  /** Работа перевозчика за ход: груз × длина. */
  logisticsWork: number;
  /** ВВП за ход: Σ добавленной стоимости фирм и перевозчика. */
  gdp: number;
  /** Сальдо бюджета за ход: доходы − расходы. */
  budgetBalance: number;
  /** Фирмы, о стройке которых решили в этот ход. */
  firmsOpened: string[];
  /** Фирмы, закрывшиеся в этот ход. */
  firmsClosed: string[];
}

export interface WorldState {
  /** Сколько ходов уже сыграно. */
  turn: number;
  wage: number;
  /** Объявленная ключевая ставка (годовая). */
  keyRate: number;
  /** Ставка, на которую уже отреагировали домохозяйства (догоняет keyRate с лагом). */
  demandRate: number;
  /** Ключевая ставка, уже дошедшая до кредитов (догоняет keyRate с лагом keyRateToCredit). */
  creditRate: number;
  provinces: Province[];
  routes: Route[];
  logistics: Logistics;
  firms: Firm[];
  market: Record<GoodId, MarketGood>;
  government: Government;
  bank: Bank;
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

export type Action =
  | { type: 'setKeyRate'; rate: number }
  | { type: 'addRoadLane'; route: string }
  | { type: 'setTax'; tax: TaxKind; rate: number }
  | { type: 'setTransfers'; perCapita: number }
  | { type: 'setSubsidy'; good: GoodId; perUnit: number };
