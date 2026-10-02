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

/** Единица автопарка перевозчика: сколько работы (груз × длина) за ход она даёт. */
export const fleetBuildingSchema = z.strictObject({
  ...buildingBase,
  kind: z.literal('fleet'),
  shape: z.literal('pentagon'),
  workCapacity: positive,
  cost: nonNegative,
});

export const buildingSchema = z.discriminatedUnion('kind', [producerBuildingSchema, storageBuildingSchema, routeBuildingSchema, fleetBuildingSchema]);

export const buildingsFileSchema = z.strictObject({
  buildings: z.array(buildingSchema).min(1),
});

// ---------- shocks.json ----------
// Шоки — нейтрально названные внешние события (GDD 2): неурожай, авария на НПЗ.

export const shockSchema = z.strictObject({
  id,
  nameKey: i18nKey,
  /** Сколько ходов действует, включая ход начала. */
  turns,
  effects: z
    .array(
      z.strictObject({
        /** Мощность зданий × multiplier (модификатор шока, GDD 5.3). */
        type: z.literal('capacity'),
        building: id,
        /** Только в этой провинции; без поля — по всей стране. */
        province: id.optional(),
        multiplier: z.number().min(0),
      }),
    )
    .min(1),
});

export const shocksFileSchema = z.strictObject({
  shocks: z.array(shockSchema),
});

// ---------- explanations.json ----------
// Шаблоны объяснений (GDD 6): какой ключ ru.json описывает метрику и каждую её причину.
// В шаблоне {имя} — один сегмент id (без точек): price.{good}.{province}.

const pattern = z.string().regex(/^[a-zA-Z0-9{}.]+$/);

export const explanationsFileSchema = z.strictObject({
  groups: z.array(
    z.strictObject({
      id,
      metrics: z.array(z.strictObject({ pattern, key: i18nKey })).min(1),
      causes: z.array(
        z.strictObject({
          pattern,
          /** Текст, когда причина увеличила метрику. */
          up: i18nKey,
          /** Текст, когда уменьшила; без поля — тот же, что up. */
          down: i18nKey.optional(),
        }),
      ),
    }),
  ),
});

export type Explanations = z.infer<typeof explanationsFileSchema>;

// ---------- balance.json ----------
// Ставки (ключевая, нейтральная, спред, цель по инфляции) — годовые доли: 0.06 = 6% годовых.

const lagSchema = z.strictObject({ first: turns, full: turns }).refine((lag) => lag.first <= lag.full, 'lag: first должен быть ≤ full');

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
      /** ρ: какую долю отклонения наценки от нормальной (initialMarkup) конкуренция снимает за ход. */
      markupReversion: share,
      /** α — липкость цен. */
      priceStickiness: share,
      /** γ — доля ожидаемой инфляции, закладываемая в цену. */
      expectedInflationPassThrough: share,
      /** Если чистая выручка за единицу ниже себестоимости, выпуск × (1 − lossOutputCut × доля убытка). */
      lossOutputCut: nonNegative,
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
    /** Номинальная зарплата падает не быстрее этой доли в месяц (зарплаты «липкие» вниз). */
    maxMonthlyWageCut: share,
  }),
  credit: z.strictObject({
    /** Спред: ставка_кредита = ключевая + спред. */
    loanSpread: nonNegative,
    /** Лимит долга фирмы в месяцах ожидаемых продаж. */
    maxDebtToMonthlySales: nonNegative,
    /** Порог: фирма расширяется, если ROI > ставка_кредита + порог. */
    expansionRoiMargin: nonNegative,
    /** Дефицит (доля неудовлетворённого спроса в провинции), который считается устойчивым. */
    entryShortageThreshold: share,
    /** Сколько ходов подряд нужен дефицит для входа новой фирмы. */
    entryShortageTurns: turns,
    /** Новая фирма входит, только если существующие производители загружены не меньше этого (дефицит из-за мощностей, а не входов). */
    entryMinUtilization: share,
    /** Минимальная наценка для входа новой фирмы. */
    entryMinMarkup: z.number().finite(),
    /** Желаемый долг населения в месяцах дохода при нейтральной ставке. */
    householdTargetDebtToMonthlyIncome: nonNegative,
    /** На сколько месяцев дохода снижается желаемый долг на каждую единицу (ставка − нейтральная). */
    householdDebtRateSensitivity: nonNegative,
    /** Какую долю разрыва (желаемый − текущий долг) население закрывает за месяц: кредит или погашение. */
    householdDebtAdjustSpeed: share,
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
    /** Товар, который транспорт сжигает (GDD 5.2). */
    fuelGood: id,
    /** Топливо на 1 ед. груза на единицу длины ребра. */
    fuelPerUnitLength: nonNegative,
    /** Труд на 1 ед. груза на каждое ребро пути. */
    laborPerUnit: nonNegative,
    /** Наценка перевозчика к себестоимости перевозки. */
    markup: nonNegative,
  }),
  /** Веса корзины ИПЦ; отсутствующие в MVP товары не указываются, веса перенормируются. */
  cpiWeights: z.record(id, positive).refine((w) => Object.keys(w).length > 0, 'cpiWeights: нужен хотя бы один товар'),
  government: z.strictObject({
    /** Премия к ставке госдолга (годовая) за каждую единицу отношения долг / годовой ВВП. */
    debtRatePremium: nonNegative,
    /** Госпредприятие на месте частной фирмы (мельница, пекарня…) дороже во столько раз (GDD 3: «дорого и неэффективно»). */
    stateFirmCostMultiplier: z.number().min(1),
  }),
  /** Катастрофы (GDD 4): проигрыш уровня до срока. */
  catastrophe: z.strictObject({
    /** Голод: дефицит этого товара у населения провинции ≥ famineShortage famineTurns ходов подряд. */
    famineGood: id,
    famineShortage: share,
    famineTurns: turns,
    /** Дефолт: госдолг ≥ этой доли годового ВВП (12 × ВВП хода). */
    defaultDebtToAnnualGdp: positive,
    /** Потеря доверия: доверие к ЦБ ≤ этого значения (динамика доверия — v0.3). */
    minTrust: share,
  }),
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
  /** Ключевая ставка, при которой рассчитано стартовое равновесие, годовая доля. */
  keyRate: z.number().finite(),
  /** Ставка, действующая на старте, если её только что изменили (уровень «Перегрев»): равновесие — при keyRate, спрос и кредит — уже при этой. */
  startKeyRate: z.number().finite().optional(),
  /** Стартовые инфляционные ожидания, годовая доля (по умолчанию — цель по инфляции). */
  expectedInflation: z.number().gt(-1).optional(),
  /** Потолки цен на старте (решение прежнего правительства): товар → доля стартовой цены производителей. */
  priceCeilings: z.record(id, z.number().positive()).optional(),
  /** Доверие к ЦБ C ∈ [0, 1] (GDD 5.9). */
  trust: share,
  /** Ставки налогов (GDD 5.11): с продаж, на прибыль, на доходы. */
  taxes: z.strictObject({
    sales: z.number().min(0).lt(1),
    profit: share,
    income: share,
  }),
  /** Трансферты населению на душу в месяц; "balanced" — столько, чтобы стартовый бюджет был сбалансирован. */
  transfersPerCapita: z.union([nonNegative, z.literal('balanced')]),
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
  /** Госрезерв на старте: склады и запасы в них. */
  reserve: z.strictObject({
    storages: z.array(z.strictObject({ building: id, province: id })),
    stock: z.array(z.strictObject({ province: id, good: id, quantity: positive })),
  }),
  /** Автопарки перевозчиков в единицах truckFleet; "auto" — столько, чтобы стартовые перевозки загружали парк не выше entryMinUtilization. */
  fleet: z.strictObject({
    private: z.union([z.number().int().nonnegative(), z.literal('auto')]),
    state: z.number().int().nonnegative(),
  }),
  /** Раскладка карты (GDD 7): виртуальные координаты, рендер вписывает их в экран. */
  map: z.strictObject({
    width: positive,
    height: positive,
    provinces: z.record(
      id,
      z.strictObject({
        /** Где стоят здания и подпись. */
        center: z.tuple([z.number(), z.number()]),
        /** Узел дорог (транспортный хаб): сюда приходят дороги, чтобы не перекрывать здания. */
        hub: z.tuple([z.number(), z.number()]),
        /** Контур провинции; рисуется сглаженным. */
        polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
      }),
    ),
    /** Изгибы дорог: точки, через которые дорога идёт от a к b (иначе — прямая между узлами). */
    routes: z.record(id, z.strictObject({ via: z.array(z.tuple([z.number(), z.number()])) })),
  }),
  /** Дороги между провинциями. lanes = 0 — дорогу можно построить, но пока не проехать. */
  routes: z.array(
    z.strictObject({
      id,
      a: id,
      b: id,
      length: positive,
      lanes: z.number().int().nonnegative(),
    }),
  ),
});

export type Scenario = z.infer<typeof scenarioSchema>;

// ---------- levels/*.json ----------
// Уровень (GDD 9, 11): сценарий, seed, срок, рычаги и стройки, шоки по ходам, цели и звёзды, брифинг, вопросы.

/** Рычаги «Политики», которые уровень может открыть. */
export const LEVERS = ['keyRate', 'taxes', 'transfers', 'subsidies', 'priceCeilings', 'reserve'] as const;

/**
 * Показатель цели. Доли: unemployment, inflationYoY (до 12 ходов — рост ИПЦ с начала уровня),
 * shortage.{товар} (по стране), maxShortage.{товар} (худшая провинция), debtToGdp (долг / годовой ВВП).
 * Уровни: cpi (старт 100), price.{товар}, realWage, budgetBalance (за ход).
 */
export const goalMetric = z
  .string()
  .regex(/^(cpi|inflationYoY|unemployment|budgetBalance|debtToGdp|realWage|(shortage|maxShortage|price)\.[a-z][a-zA-Z0-9]*)$/, 'неизвестный показатель цели');

export const conditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('metric'),
    metric: goalMetric,
    op: z.enum(['<=', '>=']),
    value: z.number().finite(),
    /** end — в последний ход; always — каждый ход начиная с from; streak — turns ходов подряд (не раньше from). */
    when: z.enum(['end', 'always', 'streak']),
    from: turns.optional(),
    turns: turns.optional(),
  }),
  z.strictObject({
    /** Ни разу не принимать решение этого вида (например, «без потолка цен»). */
    kind: z.literal('noDecision'),
    decision: z.enum([
      'setKeyRate',
      'setTax',
      'setTransfers',
      'setSubsidy',
      'setPriceCeiling',
      'reserveBuy',
      'reserveRelease',
      'addRoadLane',
      'buildStorage',
      'buildStateFleet',
      'buildStateFirm',
    ]),
  }),
]);

export const levelSchema = z.strictObject({
  id,
  /** Номер в кампании (GDD 9). */
  number: z.number().int().positive(),
  titleKey: i18nKey,
  /** Брифинг: ситуация и что нового (GDD 10: коротко, теория — в отчёте). */
  briefingKey: i18nKey,
  /** Стартовое состояние: файл data/scenarios/<scenario>.json. */
  scenario: id,
  seed: z.number().int(),
  turns,
  levers: z.array(z.enum(LEVERS)),
  /** Что можно строить: id из buildings.json (полоса дороги, склады, автопарк). */
  buildings: z.array(id),
  /** Шоки по ходам: шок срабатывает в ходе, который даёт месяц turn. */
  events: z.array(z.strictObject({ turn: turns, shock: id })),
  /**
   * Цели. star 1 — пройти уровень (все цели звезды 1), star 2 — основная цель с запасом,
   * star 3 — дополнительное условие. Звезда N даётся, только если получены все младшие.
   */
  goals: z
    .array(
      z.strictObject({
        id,
        star: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        condition: conditionSchema,
      }),
    )
    .min(1),
  /** Вопросы для обсуждения в отчёте (GDD 10). */
  questions: z.array(i18nKey),
});

export type Level = z.infer<typeof levelSchema>;
export type Lever = (typeof LEVERS)[number];
export type GoalCondition = z.infer<typeof conditionSchema>;
export type Lag = z.infer<typeof lagSchema>;
export type Shock = z.infer<typeof shockSchema>;
export type Good = z.infer<typeof goodSchema>;
export type Recipe = z.infer<typeof recipeSchema>;
export type Building = z.infer<typeof buildingSchema>;
export type ProducerBuilding = z.infer<typeof producerBuildingSchema>;
export type StorageBuilding = z.infer<typeof storageBuildingSchema>;
export type RouteBuilding = z.infer<typeof routeBuildingSchema>;
export type FleetBuilding = z.infer<typeof fleetBuildingSchema>;
export type Balance = z.infer<typeof balanceSchema>;
