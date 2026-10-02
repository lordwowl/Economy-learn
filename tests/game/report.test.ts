import { describe, expect, it } from 'vitest';
import { getGameData, getLevels, getScenario, type Level } from '../../src/data';
import { findCause, findMetric } from '../../src/game/explain';
import { advanceLevel, evaluateLevel, startLevel } from '../../src/game/level';
import { causalChain, decisionRefs, levelReport } from '../../src/game/report';
import { addDecision, currentState, type Session } from '../../src/game/session';
import { aggregate } from '../../src/sim/causes';
import type { Action, WorldState } from '../../src/sim';

const data = getGameData();
const harvest = getLevels().find((l) => l.id === 'harvest')!;

function play(level: Level, decide: (state: WorldState) => Action[] = () => []): Session {
  let s = startLevel(data, level, getScenario(level.scenario));
  while (evaluateLevel(level, s.history, data.balance).outcome === 'playing') {
    for (const action of decide(currentState(s))) s = addDecision(s, action);
    s = advanceLevel(s, data, level, 1);
  }
  return s;
}

describe('отчёт уровня: причинная цепочка (GDD 6)', () => {
  const passive = play(harvest);
  const ceiling = play(harvest, (s) => (s.turn === 1 ? [{ type: 'setPriceCeiling', good: 'bread', price: Math.round(s.market.bread!.price * 0.85) }] : []));

  it('цепочка спускается от итога по главной причине в ту же сторону', () => {
    const chain = causalChain(passive.history, 'cpi');
    expect(chain[0]!.metric).toBe('cpi');
    const events = passive.history.flatMap((h) => h.causes);
    for (const [i, link] of chain.entries()) {
      const total = aggregate(events, link.metric);
      expect(link.delta).toBeCloseTo(total.delta, 9);
      expect(Math.sign(link.cause.value)).toBe(Math.sign(link.delta));
      const same = total.causes.filter((c) => Math.sign(c.value) === Math.sign(total.delta));
      expect(Math.abs(link.cause.value)).toBe(Math.max(...same.map((c) => Math.abs(c.value))));
      const next = chain[i + 1];
      if (next) expect(next.metric).toBe(`price.${link.cause.ref.split('.').at(-1)}`.replace('price.wage', 'wage'));
    }
  });

  it('у каждого звена и его причины есть шаблон текста', () => {
    for (const s of [passive, ceiling]) {
      for (const chain of levelReport(harvest, s.history, data.balance).chains) {
        for (const link of chain.links) {
          const metric = findMetric(link.metric);
          expect(metric, link.metric).toBeDefined();
          expect(findCause(metric!.group, link.cause.ref), `${link.metric} ← ${link.cause.ref}`).toBeDefined();
        }
      }
    }
  });

  it('потолок цен: цепочка ведёт к решению игрока', () => {
    const report = levelReport(harvest, ceiling.history, data.balance);
    const chain = report.chains[0]!;
    expect(chain.links.map((l) => l.metric)).toEqual(['cpi', 'price.bread']);
    expect(chain.links.at(-1)!.cause.ref).toBe('priceCeiling');
    expect(chain.decisions).toHaveLength(1);
    expect(chain.decisions[0]).toMatchObject({ turn: 2, action: { type: 'setPriceCeiling', good: 'bread' } });
  });

  it('в отчёте — решения игрока и события уровня с месяцами', () => {
    const report = levelReport(harvest, ceiling.history, data.balance);
    expect(report.decisions).toEqual([{ turn: 2, action: ceiling.history[2]!.actions[0] }]);
    expect(report.events).toEqual([{ turn: 3, action: { type: 'shock', shock: 'harvestFailure' } }]);
    expect(report.status.outcome).toBe('defeated');
  });

  it('решения связаны только со своими причинами', () => {
    expect(decisionRefs({ type: 'setPriceCeiling', good: 'bread', price: 1 }, 'price.bread')).toEqual(['priceCeiling', 'blackMarket']);
    expect(decisionRefs({ type: 'setPriceCeiling', good: 'bread', price: 1 }, 'price.flour')).toEqual([]);
    expect(decisionRefs({ type: 'setSubsidy', good: 'flour', perUnit: 1 }, 'price.flour')).toEqual(['subsidy']);
    expect(decisionRefs({ type: 'setTax', tax: 'sales', rate: 0.1 }, 'price.bread')).toEqual(['tax.sales']);
    expect(decisionRefs({ type: 'setTax', tax: 'income', rate: 0.1 }, 'budget.balance')).toEqual(['tax.income']);
    expect(decisionRefs({ type: 'setKeyRate', rate: 0.1 }, 'cpi')).toEqual([]);
  });
});
