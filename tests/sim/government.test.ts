import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { run } from './helpers';

const TURNS = 18;
const passive = run(TURNS);

describe('бюджет (GDD 5.11)', () => {
  it('после хода у государства нет минуса на счёте: дефицит закрыт займом, долг ≥ 0', () => {
    for (const s of passive.states) {
      expect(s.government.cash).toBeGreaterThanOrEqual(-1e-9);
      expect(s.government.debt).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('сальдо бюджета = доходы − расходы и раскладывается по статьям', () => {
    for (let t = 1; t <= TURNS; t++) {
      const s = passive.states[t]!;
      const revenue = Object.values(s.government.revenue).reduce((a, b) => a + b, 0);
      const spending = Object.values(s.government.spending).reduce((a, b) => a + b, 0);
      expect(s.metrics.budgetBalance).toBeCloseTo(revenue - spending, 6);
      const e = passive.causes[t]!.find((c) => c.metric === 'budget.balance')!;
      expect(e.causes.reduce((a, c) => a + c.value, 0)).toBeCloseTo(e.delta, 9);
    }
  });

  it('сбалансированные трансферты: стартовый бюджет близок к нулю', () => {
    const s = passive.states[1]!;
    const revenue = Object.values(s.government.revenue).reduce((a, b) => a + b, 0);
    expect(Math.abs(s.metrics.budgetBalance)).toBeLessThan(0.05 * revenue);
  });

  it('налог с продаж сидит в цене отдельной компонентой ≈ τ × P', () => {
    const s = passive.states[TURNS]!;
    const tax = s.government.taxes.sales;
    for (const f of s.firms) expect(f.breakdown['tax.sales']! / f.price).toBeCloseTo(tax, 1);
  });
});

describe('рычаги бюджета', () => {
  it('налог с продаж ↑ → цены выше, доходы бюджета выше', () => {
    const r = run(TURNS, (t) => (t === 2 ? [{ type: 'setTax', tax: 'sales', rate: 0.2 }] : []));
    const t = 8;
    expect(r.states[t]!.metrics.cpi).toBeGreaterThan(passive.states[t]!.metrics.cpi);
    expect(r.states[t]!.government.revenue['tax.sales']!).toBeGreaterThan(passive.states[t]!.government.revenue['tax.sales']!);
  });

  it('трансферты ↑ → дефицит и долг растут, население тратит больше', () => {
    const base = passive.states[0]!.government.transfersPerCapita;
    const r = run(TURNS, (t) => (t === 2 ? [{ type: 'setTransfers', perCapita: base * 1.5 }] : []));
    const t = 6;
    expect(r.states[t]!.government.debt).toBeGreaterThan(passive.states[t]!.government.debt);
    expect(r.states[t]!.metrics.householdSpending).toBeGreaterThan(passive.states[t]!.metrics.householdSpending);
  });

  it('налог на доходы ↑ → население тратит меньше', () => {
    const r = run(TURNS, (t) => (t === 2 ? [{ type: 'setTax', tax: 'income', rate: 0.3 }] : []));
    expect(r.states[4]!.metrics.householdSpending).toBeLessThan(passive.states[4]!.metrics.householdSpending);
  });

  it('стройка полосы оплачивается из бюджета: cost = цена за длину × длина', () => {
    const lane = getGameData().buildings.find((b) => b.kind === 'route');
    if (lane?.kind !== 'route') throw new Error('нет полосы в данных');
    const r = run(2, (t) => (t === 1 ? [{ type: 'addRoadLane', route: 'northCenter' }] : []));
    const length = r.states[0]!.routes.find((x) => x.id === 'northCenter')!.length;
    expect(r.states[1]!.government.spending.construction).toBeCloseTo(lane.costPerLength * length, 9);
  });
});
