import { describe, expect, it } from 'vitest';
import { getExplanations } from '../../src/data';
import { contextFromState, findCause, findMetric, formatWhyLine, matchPattern, metricLabel, why } from '../../src/game/explain';
import { hasKey } from '../../src/i18n';
import { aggregate } from '../../src/sim/causes';
import type { Action } from '../../src/sim';
import { run } from '../sim/helpers';

describe('шаблоны', () => {
  it('{имя} — ровно один сегмент id', () => {
    expect(matchPattern('price.{good}', 'price.bread')).toEqual({ good: 'bread' });
    expect(matchPattern('price.{good}', 'price.bread.north')).toBeUndefined();
    expect(matchPattern('price.{good}.{province}', 'price.bread.north')).toEqual({ good: 'bread', province: 'north' });
    expect(matchPattern('cpi', 'cpi')).toEqual({});
  });

  it('все ключи explanations.json есть в ru.json', () => {
    for (const g of getExplanations().groups) {
      for (const m of g.metrics) expect(hasKey(m.key), m.key).toBe(true);
      for (const c of g.causes) {
        expect(hasKey(c.up), c.up).toBe(true);
        if (c.down) expect(hasKey(c.down), c.down).toBe(true);
      }
    }
  });
});

// Прогон «всё сразу»: все рычаги и шоки, чтобы в журнале встретились все виды причин.
const actions: Record<number, Action[]> = {
  1: [
    { type: 'buildStorage', building: 'warehouse', province: 'north' },
    { type: 'buildStateFleet' },
    { type: 'addRoadLane', route: 'northCenter' },
    { type: 'setSubsidy', good: 'flour', perUnit: 30 },
    { type: 'setTax', tax: 'sales', rate: 0.12 },
  ],
  2: [{ type: 'shock', shock: 'harvestFailure' }],
  3: [{ type: 'setPriceCeiling', good: 'bread', price: 600 }],
  4: [{ type: 'reserveBuy', good: 'fuel', province: 'north', quantity: 100 }],
  5: [
    { type: 'shock', shock: 'refineryAccident' },
    { type: 'setKeyRate', rate: 0.1 },
  ],
  6: [{ type: 'reserveRelease', good: 'fuel', province: 'north', quantity: 100 }],
  8: [{ type: 'setTransfers', perCapita: 200 }],
};
const everything = run(14, (t) => actions[t] ?? []);
const events = everything.causes.flat();

describe('у каждой причины в журнале есть объяснение', () => {
  it('прогон задействовал рычаги: потолок, субсидия, резерв, госпарк, шоки', () => {
    const refs = new Set(events.flatMap((e) => e.causes.map((c) => c.ref)));
    for (const ref of ['priceCeiling', 'subsidy', 'reserve', 'stateCarrier', 'logistics', 'employment.farm']) expect(refs).toContain(ref);
  });

  it('каждая метрика и каждая причина находят шаблон', () => {
    const missing: string[] = [];
    for (const e of events) {
      const metric = findMetric(e.metric);
      if (!metric) {
        missing.push(`метрика ${e.metric}`);
        continue;
      }
      for (const c of e.causes) if (!findCause(metric.group, c.ref)) missing.push(`${e.metric}: ${c.ref}`);
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('тексты подставлены полностью, без {…} и без сырых id', () => {
    const ctx = contextFromState(everything.states.at(-1)!);
    for (const e of events.slice(0, 400)) {
      const label = metricLabel(e.metric, ctx);
      expect(label).not.toMatch(/[{}]/);
      for (const line of why(e, ctx)) {
        expect(line.text).not.toMatch(/[{}]/);
        expect(line.text).not.toBe(line.ref);
      }
    }
  });
});

describe('«Почему?»', () => {
  const ctx = contextFromState(everything.states.at(-1)!);
  const cpi = everything.causes[6]!.find((e) => e.metric === 'cpi')!;

  it('не больше трёх причин, по убыванию вклада, со стрелкой и долей', () => {
    const lines = why(cpi, ctx);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < lines.length; i++) expect(Math.abs(lines[i - 1]!.value)).toBeGreaterThanOrEqual(Math.abs(lines[i]!.value));
    expect(formatWhyLine(lines[0]!)).toMatch(/^[▲▼] .+ — \d+%$/);
  });

  it('доля причины — в общем движении: от 0 до 100%, по всем причинам в сумме 100%', () => {
    for (const e of events) {
      if (e.causes.length === 0) continue;
      const lines = why(e, contextFromState(everything.states.at(-1)!), e.causes.length);
      for (const l of lines) expect(Math.abs(l.share)).toBeLessThanOrEqual(1 + 1e-12);
      expect(lines.reduce((s, l) => s + Math.abs(l.share), 0)).toBeCloseTo(1, 9);
    }
  });

  it('пример: название цены по провинции', () => {
    expect(metricLabel('price.bread.north', ctx)).toBe('Цена «Хлеб» (Северная провинция)');
  });
});

describe('сводка за период', () => {
  it('вклады за несколько ходов складываются, сумма = изменение метрики', () => {
    const total = aggregate(events, 'cpi');
    const first = everything.states[0]!.metrics.cpi;
    const last = everything.states.at(-1)!.metrics.cpi;
    expect(total.delta).toBeCloseTo(last - first, 9);
    expect(total.causes.reduce((a, c) => a + c.value, 0)).toBeCloseTo(total.delta, 9);
  });
});
