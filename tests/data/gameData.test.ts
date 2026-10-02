import { describe, expect, it } from 'vitest';
import balance from '../../data/balance.json';
import buildings from '../../data/buildings.json';
import goods from '../../data/goods.json';
import recipes from '../../data/recipes.json';
import shocks from '../../data/shocks.json';
import ru from '../../src/i18n/ru.json';
import scenario from '../../data/scenarios/baseline.json';
import level05 from '../../data/levels/05_harvest.json';
import { GameDataError, getGameData, getLevels, getScenarios, loadGameData, loadLevel, loadScenario, type RawGameData, type Scenario } from '../../src/data';
import { conditionSchema } from '../../src/data/schemas';

const raw = (): RawGameData => structuredClone({ balance, goods, recipes, buildings, shocks });

function issuesOf(data: RawGameData): string[] {
  try {
    loadGameData(data);
  } catch (error) {
    if (error instanceof GameDataError) return error.issues;
    throw error;
  }
  return [];
}

describe('данные игры из data/', () => {
  it('проходят валидацию', () => {
    expect(issuesOf(raw())).toEqual([]);
  });

  it('содержат товары MVP (GDD 5.2)', () => {
    expect(
      getGameData()
        .goods.map((g) => g.id)
        .sort(),
    ).toEqual(['bread', 'flour', 'fuel', 'grain']);
  });

  it('у каждого товара и здания есть строка в ru.json', () => {
    const data = getGameData();
    const keys = [...data.goods, ...data.buildings, ...data.shocks].map((x) => x.nameKey);
    for (const key of keys) expect(Object.keys(ru), key).toContain(key);
  });

  it('рецепты совпадают с таблицей GDD 5.2', () => {
    const byId = new Map(getGameData().recipes.map((r) => [r.id, r]));
    expect(byId.get('flour')).toEqual({
      id: 'flour',
      output: { good: 'flour', amount: 0.8 },
      inputs: [
        { good: 'grain', amount: 1 },
        { good: 'fuel', amount: 0.05 },
      ],
      labor: 0.1,
    });
    expect(byId.get('bread')?.labor).toBe(0.3);
  });

  it('топливо — сквозной ресурс: входит во все рецепты, кроме самого топлива', () => {
    for (const recipe of getGameData().recipes) {
      if (recipe.output.good === 'fuel') continue;
      expect(
        recipe.inputs.map((i) => i.good),
        recipe.id,
      ).toContain('fuel');
    }
  });

  it('у каждого здания своя форма (цвет не единственный носитель смысла)', () => {
    const shapes = getGameData().buildings.map((b) => b.shape);
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});

describe('валидация ловит ошибки', () => {
  it('неизвестное поле (опечатка в константе)', () => {
    const data = raw();
    (data.balance as { labor: Record<string, unknown> }).labor.wageAdjustSped = 0.5;
    expect(issuesOf(data).join('\n')).toMatch(/balance\.json: labor/);
  });

  it('пропущенная константа', () => {
    const data = raw();
    delete (data.balance as { firms: Partial<Record<string, unknown>> }).firms.priceStickiness;
    expect(issuesOf(data).join('\n')).toMatch(/balance\.json: firms\.priceStickiness/);
  });

  it('рецепт ссылается на несуществующий товар', () => {
    const data = raw();
    (data.recipes as typeof recipes).recipes[0]!.inputs[0]!.good = 'coal';
    expect(issuesOf(data)).toContain('recipes.json: grain: неизвестный товар "coal"');
  });

  it('здание ссылается на несуществующий рецепт', () => {
    const data = raw();
    const farm = (data.buildings as typeof buildings).buildings[0] as { recipe?: string };
    farm.recipe = 'milk';
    expect(issuesOf(data)).toContain('buildings.json: farm: неизвестный рецепт "milk"');
  });

  it('повторяющийся id', () => {
    const data = raw();
    const list = (data.goods as typeof goods).goods;
    list.push({ ...list[0]! });
    expect(issuesOf(data)).toContain('goods.json: повторяющийся id "grain"');
  });

  it('задержка: first > full', () => {
    const data = raw();
    (data.balance as typeof balance).lags.subsidyToPrice = { first: 3, full: 1 };
    expect(issuesOf(data).join('\n')).toMatch(/lags\.subsidyToPrice/);
  });

  it('наценка вне [markupMin, markupMax]', () => {
    const data = raw();
    (data.balance as typeof balance).firms.initialMarkup = 0.9;
    expect(issuesOf(data).join('\n')).toMatch(/markupMin ≤ initialMarkup ≤ markupMax/);
  });

  it('товар в корзине ИПЦ, который не покупают домохозяйства', () => {
    const data = raw();
    (data.balance as { cpiWeights: Record<string, number> }).cpiWeights.grain = 0.1;
    expect(issuesOf(data).join('\n')).toMatch(/cpiWeights: товар "grain"/);
  });

  it('собирает все ошибки сразу, а не только первую', () => {
    const data = raw();
    (data.balance as typeof balance).labor.wageAdjustSpeed = -1;
    (data.goods as typeof goods).goods[0]!.id = 'Bad Id';
    expect(issuesOf(data).length).toBeGreaterThanOrEqual(2);
  });
});

describe('сценарии', () => {
  const scenarioIssues = (raw: unknown): string[] => {
    try {
      loadScenario(raw, getGameData(), 'test.json');
    } catch (error) {
      if (error instanceof GameDataError) return error.issues;
      throw error;
    }
    return [];
  };

  it('baseline.json валиден, у провинций есть строки в ru.json', () => {
    expect(scenarioIssues(scenario)).toEqual([]);
    for (const p of scenario.provinces) expect(Object.keys(ru)).toContain(p.nameKey);
  });

  it('ловит неизвестное здание, провинцию и рабочую силу больше населения', () => {
    const bad = structuredClone(scenario) as unknown as Scenario;
    bad.firms.push({ building: 'warehouse', province: 'nowhere', count: 1 });
    bad.provinces[0]!.laborForce = bad.provinces[0]!.population + 1;
    const issues = scenarioIssues(bad).join('\n');
    expect(issues).toMatch(/"warehouse" не производственное здание/);
    expect(issues).toMatch(/неизвестная провинция "nowhere"/);
    expect(issues).toMatch(/рабочая сила больше населения/);
  });

  it('ловит провинцию без раскладки на карте и изгиб неизвестной дороги', () => {
    const bad = structuredClone(scenario) as unknown as Scenario;
    delete bad.map.provinces.south;
    bad.map.routes.ghost = { via: [] };
    const issues = scenarioIssues(bad).join('\n');
    expect(issues).toMatch(/нет раскладки провинции "south"/);
    expect(issues).toMatch(/изгиб неизвестной дороги "ghost"/);
  });

  it('ловит запас резерва, который негде хранить', () => {
    const bad = structuredClone(scenario) as unknown as Scenario;
    bad.reserve.storages.push({ building: 'elevator', province: 'north' });
    bad.reserve.stock.push({ province: 'north', good: 'bread', quantity: 10 });
    expect(scenarioIssues(bad).join('\n')).toMatch(/"bread" в провинции "north" негде хранить/);
  });

  it('ловит дорогу в неизвестную провинцию, петлю и дубль', () => {
    const bad = structuredClone(scenario) as unknown as Scenario;
    bad.routes.push({ id: 'toNowhere', a: 'north', b: 'nowhere', length: 1, lanes: 1 });
    bad.routes.push({ id: 'loop', a: 'south', b: 'south', length: 1, lanes: 1 });
    bad.routes.push({ id: 'twin', a: 'center', b: 'north', length: 2, lanes: 1 });
    const issues = scenarioIssues(bad).join('\n');
    expect(issues).toMatch(/toNowhere: неизвестная провинция "nowhere"/);
    expect(issues).toMatch(/loop ведёт в ту же провинцию/);
    expect(issues).toMatch(/twin дублирует/);
  });
});

describe('уровни', () => {
  const levelIssues = (patch: (level: Record<string, unknown>) => void): string[] => {
    const raw = structuredClone(level05) as unknown as Record<string, unknown>;
    patch(raw);
    try {
      loadLevel(raw, getGameData(), getScenarios(), 'test.json');
    } catch (error) {
      if (error instanceof GameDataError) return error.issues;
      throw error;
    }
    return [];
  };
  const goals = (level: Record<string, unknown>) => level.goals as { id: string; star: number; condition: Record<string, unknown> }[];

  it('все уровни валидны, у текстов есть строки в ru.json', () => {
    const levels = getLevels();
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      for (const key of [level.titleKey, level.briefingKey, ...level.questions]) expect(Object.keys(ru), key).toContain(key);
      for (const goal of level.goals) {
        const c = goal.condition;
        const key = c.kind === 'metric' ? `goal.metric.${c.metric.split('.')[0]}` : `goal.noDecision.${c.decision}`;
        expect(Object.keys(ru), key).toContain(key);
      }
    }
  });

  it('у каждого вида решения для noDecision есть текст', () => {
    for (const decision of conditionSchema.options[1].shape.decision.options) expect(Object.keys(ru)).toContain(`goal.noDecision.${decision}`);
  });

  it('ловит ошибки ссылок и сроков', () => {
    expect(levelIssues((l) => (l.scenario = 'nope'))).toContain('test.json: неизвестный сценарий "nope"');
    expect(levelIssues((l) => (l.events = [{ turn: 3, shock: 'meteor' }]))).toContain('test.json: неизвестный шок "meteor"');
    expect(levelIssues((l) => (l.events = [{ turn: 99, shock: 'harvestFailure' }])).join('\n')).toMatch(/позже конца уровня/);
    expect(levelIssues((l) => (l.buildings = ['farm'])).join('\n')).toMatch(/нельзя строить/);
    expect(levelIssues((l) => (goals(l)[0]!.condition.metric = 'price.coal')).join('\n')).toMatch(/неизвестный товар "coal"/);
    expect(levelIssues((l) => (goals(l)[0]!.condition.metric = 'happiness')).join('\n')).toMatch(/неизвестный показатель/);
    expect(levelIssues((l) => (goals(l)[0]!.condition.when = 'streak')).join('\n')).toMatch(/для streak нужно turns/);
    expect(levelIssues((l) => (l.goals = goals(l).filter((g) => g.star !== 2))).join('\n')).toMatch(/звезду 2/);
    expect(levelIssues((l) => (goals(l)[1]!.id = goals(l)[0]!.id)).join('\n')).toMatch(/повторяющийся id/);
  });

  it('голод — товар из данных', () => {
    const data = raw();
    (data.balance as typeof balance).catastrophe.famineGood = 'rice';
    expect(issuesOf(data).join('\n')).toMatch(/catastrophe\.famineGood: неизвестный товар "rice"/);
  });
});
