import { z } from 'zod';

// Схемы JSON-контента из data/ (GDD, раздел 11). Все объекты строгие:
// опечатка в имени поля — ошибка загрузки, а не молча проигнорированная константа.

const id = z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'id: латиница в camelCase');
const i18nKey = z.string().min(1);
const nonNegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const share = z.number().min(0).max(1);
const turns = z.number().int().positive();

// ---------- goods.json ----------

export const goodSchema = z.strictObject({
  id,
  nameKey: i18nKey,
});

export const goodsFileSchema = z.strictObject({
  goods: z.array(goodSchema).min(1),
});

// ---------- recipes.json ----------

const goodAmount = z.strictObject({
  good: id,
  amount: positive,
});

/** Рецепт: сколько выхода даёт одна единица мощности и что на неё тратится (GDD 5.2). */
export const recipeSchema = z.strictObject({
  id,
  output: goodAmount,
  inputs: z.array(goodAmount),
  /** Труд на единицу мощности. */
  labor: nonNegative,
});

export const recipesFileSchema = z.strictObject({
  recipes: z.array(recipeSchema).min(1),
});

// ---------- buildings.json ----------

const buildingBase = {
  id,
  nameKey: i18nKey,
  owner: z.enum(['private', 'state']),
  buildTurns: turns,
};

export const producerBuildingSchema = z.strictObject({
  ...buildingBase,
  kind: z.literal('producer'),
  shape: z.enum(['circle', 'square', 'hexagon', 'diamond']),
  recipe: id,
  /** Мощность: максимум запусков рецепта за ход. */
  capacity: positive,
  cost: nonNegative,
});

export const storageBuildingSchema = z.strictObject({
  ...buildingBase,
  kind: z.literal('storage'),
  /** Склад — треугольник, элеватор — перевёрнутый треугольник (GDD 7). */
  shape: z.enum(['triangle', 'triangleDown']),
  storageCapacity: positive,
  storedGoods: z.array(id).min(1),
  cost: nonNegative,
});

export const routeBuildingSchema = z.strictObject({
  ...buildingBase,
  kind: z.literal('route'),
  shape: z.literal('line'),
  /** Единиц товара за ход на одну полосу. */
  capacityPerLane: positive,
  costPerLength: nonNegative,
});

export const buildingSchema = z.discriminatedUnion('kind', [
  producerBuildingSchema,
  storageBuildingSchema,
  routeBuildingSchema,
]);

export const buildingsFileSchema = z.strictObject({
  buildings: z.array(buildingSchema).min(1),
});

// ---------- balance.json ----------
// Ставки (ключевая, нейтральная, спред, цель по инфляции) — годовые доли: 0.06 = 6% годовых.

const lagSchema = z
  .strictObject({ first: turns, full: turns })
  .refine((lag) => lag.first <= lag.full, 'lag: first должен быть ≤ full');

const demandGoodSchema = z.strictObject({
  /** base_i из GDD 5.5: потребление на душу при P = P_ref и B = B_ref (P_ref и B_ref — стартовые значения уровня). */
  basePerCapita: positive,
  /** ε_i: ценовая эластичность, ≤ 0. */
  priceElasticity: z.number().max(0),
  /** η_i: эластичность по доходу. */
  incomeElasticity: z.number().finite(),
  /** Минимум потребления как доля base_i (для хлеба > 0). */
  minShareOfBase: share,
});

export const balanceSchema = z.strictObject({
  firms: z
    .strictObject({
      /** cov_target / целевое_покрытие (GDD 5.3, 5.4). */
      targetCoverage: positive,
      /** Окно средних продаж для покрытия, ходов. */
      salesAverageTurns: turns,
      /** Верхняя граница покрытия (запас / средние заказы), в месяцах заказов. */
      coverageCap: positive,
      /** k: какую долю разрыва покрытия фирма закрывает за ход (1 = весь сразу). */
      inventoryAdjustSpeed: z.number().gt(0).max(1),
      initialMarkup: z.number().finite(),
      /** m_min, m_max. */
      markupMin: z.number().finite(),
      markupMax: z.number().finite(),
      /** β. */
      markupAdjustSpeed: nonNegative,
      /** α — липкость цен. */
      priceStickiness: share,
      /** γ — доля ожидаемой инфляции, закладываемая в цену. */
      expectedInflationPassThrough: share,
      /** Сколько месяцев издержек фирма держит на счёте; остальное — дивиденды. */
      cashBufferTurns: nonNegative,
      /** Доля избытка денег сверх буфера, выплачиваемая владельцам за ход. */
      dividendPayoutShare: share,
      /** N месяцев убытков до закрытия (GDD 5.8). */
      closeAfterLossTurns: turns,
    })
    .refine((f) => f.markupMin <= f.initialMarkup && f.initialMarkup <= f.markupMax, {
      message: 'firms: нужно markupMin ≤ initialMarkup ≤ markupMax',
    })
    .refine((f) => f.targetCoverage <= f.coverageCap, {
      message: 'firms: нужно targetCoverage ≤ coverageCap',
    }),
  demand: z.strictObject({
    /** s0. */
    baseSpendingShare: share,
    /** k_r. */
    rateSensitivity: nonNegative,
    neutralRate: z.number().finite(),
    goods: z.record(id, demandGoodSchema),
  }),
  labor: z.strictObject({
    /** u*. */
    naturalUnemployment: share,
    /** φ. */
    wageAdjustSpeed: nonNegative,
  }),
  credit: z.strictObject({
    /** Спред: ставка_кредита = ключевая + спред. */
    loanSpread: nonNegative,
    /** Порог: фирма расширяется, если ROI > ставка_кредита + порог. */
    expansionRoiMargin: nonNegative,
    /** Сколько ходов подряд нужен дефицит для входа новой фирмы. */
    entryShortageTurns: turns,
    /** Минимальная наценка для входа новой фирмы. */
    entryMinMarkup: z.number().finite(),
  }),
  expectations: z.strictObject({
    /** π_цель. */
    inflationTarget: z.number().finite(),
    /** λ. */
    adaptiveWeight: share,
  }),
  fx: z.strictObject({
    /** κ. */
    tradeBalanceSensitivity: nonNegative,
    /** μ. */
    rateDifferentialSensitivity: nonNegative,
    /** Перенос курса в цену импорта, ходов. */
    importPassThroughTurns: turns,
  }),
  priceCeiling: z.strictObject({
    /** Доля неудовлетворённого спроса, уходящая на чёрный рынок. */
    blackMarketShareOfUnmet: share,
    /** k в P_bm = P_ceiling × (1 + k × дефицит). */
    blackMarketPremiumPerShortage: nonNegative,
  }),
  logistics: z.strictObject({
    /** Топливо на 1 ед. груза на единицу длины ребра. */
    fuelPerUnitLength: nonNegative,
    /** Труд на 1 ед. груза. */
    laborPerUnit: nonNegative,
  }),
  /** Веса корзины ИПЦ; отсутствующие в MVP товары не указываются, веса перенормируются. */
  cpiWeights: z
    .record(id, positive)
    .refine((w) => Object.keys(w).length > 0, 'cpiWeights: нужен хотя бы один товар'),
  /** Задержки решений, ходов (GDD 5.12). Задержки строек — в buildings.json. */
  lags: z.strictObject({
    keyRateToCredit: lagSchema,
    keyRateToDemand: lagSchema,
    keyRateToPrices: lagSchema,
    subsidyToPrice: lagSchema,
    tariffToImportPrice: lagSchema,
    tariffToSubstitution: lagSchema,
    priceCeilingToShortage: lagSchema,
  }),
});

// ---------- scenarios/*.json ----------
// Стартовое состояние экономики. Уровни (M11) будут включать такой же блок.

export const scenarioSchema = z.strictObject({
  /** Стартовая зарплата за единицу труда. */
  wage: positive,
  /** Стартовая ключевая ставка, годовая доля. */
  keyRate: z.number().finite(),
  /** Доверие к ЦБ C ∈ [0, 1] (GDD 5.9). */
  trust: share,
  provinces: z
    .array(
      z.strictObject({
        id,
        nameKey: i18nKey,
        population: positive,
        laborForce: positive,
      }),
    )
    .min(1),
  firms: z.array(
    z.strictObject({
      building: id,
      province: id,
      count: z.number().int().positive(),
    }),
  ),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Lag = z.infer<typeof lagSchema>;
export type Good = z.infer<typeof goodSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type Building = z.infer<typeof buildingSchema>;
export type ProducerBuilding = z.infer<typeof producerBuildingSchema>;
export type StorageBuilding = z.infer<typeof storageBuildingSchema>;
export type RouteBuilding = z.infer<typeof routeBuildingSchema>;
export type Balance = z.infer<typeof balanceSchema>;
