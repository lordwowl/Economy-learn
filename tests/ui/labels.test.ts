import { describe, expect, it } from 'vitest';
import { getGameData, getLevels, getScenario, type GoalCondition } from '../../src/data';
import { contextFromState } from '../../src/game/explain';
import { advanceLevel, evaluateLevel, startLevel } from '../../src/game/level';
import { levelReport } from '../../src/game/report';
import { addDecision, currentState } from '../../src/game/session';
import { chainChange, describeChainLink, describeDefeat, describeGoal, describeGoalStatus } from '../../src/ui/labels';

const data = getGameData();
const harvest = getLevels().find((l) => l.id === 'harvest')!;
/** Текст без невыставленных ключей и плейсхолдеров. */
const complete = (text: string) => !/\{\w+\}|(^|\s)(goal|report|cause|metric)\.[a-zA-Z.]+/.test(text);

describe('тексты целей и отчёта', () => {
  it('цели: все виды условий описываются полностью и с единицами', () => {
    const conditions: GoalCondition[] = [
      { kind: 'metric', metric: 'cpi', op: '<=', value: 110, when: 'end' },
      { kind: 'metric', metric: 'unemployment', op: '<=', value: 0.08, when: 'always' },
      { kind: 'metric', metric: 'maxShortage.bread', op: '<=', value: 0.4, when: 'always', from: 3 },
      { kind: 'metric', metric: 'price.bread', op: '>=', value: 500, when: 'streak', turns: 6 },
      { kind: 'metric', metric: 'inflationYoY', op: '<=', value: 0.045, when: 'end' },
      { kind: 'noDecision', decision: 'setPriceCeiling' },
    ];
    const texts = conditions.map(describeGoal);
    for (const text of texts) expect(complete(text), text).toBe(true);
    expect(texts[0]).toBe('ИПЦ в конце уровня не выше 110,0');
    expect(texts[1]).toBe('Безработица каждый месяц не выше 8%');
    expect(texts[2]).toBe('Дефицит «Хлеб» в каждой провинции с месяца 3 не выше 40%');
    expect(texts[3]).toMatch(/^Цена «Хлеб» не ниже 500 кол\. — 6 мес\. подряд$/);
    expect(texts[4]).toMatch(/4,5%$/);
    expect(texts[5]).toBe('Без потолка цен');
  });

  it('отчёт: статусы целей, катастрофа и звенья цепочки — без сырых ключей', () => {
    let s = startLevel(data, harvest, getScenario(harvest.scenario));
    while (evaluateLevel(harvest, s.history, data.balance).outcome === 'playing') {
      const st = currentState(s);
      if (st.turn === 1) s = addDecision(s, { type: 'setPriceCeiling', good: 'bread', price: Math.round(st.market.bread!.price * 0.85) });
      s = advanceLevel(s, data, harvest, 1);
    }
    const report = levelReport(harvest, s.history, data.balance);
    const start = s.history[0]!.state;
    const last = currentState(s);
    const texts = [
      ...report.status.goals.map(describeGoalStatus),
      describeDefeat(report.status.defeat!, last, data.balance),
      ...report.chains.flatMap((c) => c.links.flatMap((l) => Object.values(describeChainLink(l, start, contextFromState(last))))),
    ];
    for (const text of texts) expect(complete(text), text).toBe(true);
    expect(texts.join('\n')).toMatch(/Голод: в провинции «.+» дефицит товара «Хлеб» не меньше 50%/);
  });

  it('изменения за уровень: ИПЦ в пунктах, цены в %, безработица в п.п.', () => {
    const start = startLevel(data, harvest, getScenario(harvest.scenario)).history[0]!.state;
    expect(chainChange('cpi', 4.25, start)).toBe('+4,3 п.');
    expect(chainChange('unemployment', -0.012, start)).toBe('−1,2 п.п.');
    expect(chainChange('price.bread', start.market.bread!.price * 0.1, start)).toBe('+10,0%');
  });
});
