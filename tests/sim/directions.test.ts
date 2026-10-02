// «Честность» модели (CLAUDE.md): направления эффектов. Ставка и потолок — в step.test и ceiling.test.
import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { run } from './helpers';

const TURNS = 12;
const SHOCK_TURN = 2;
const passive = run(TURNS);
const shocks = getGameData().shocks;

describe('шоки (GDD 5.3)', () => {
  const harvest = shocks.find((s) => s.id === 'harvestFailure')!;
  const r = run(TURNS, (t) => (t === SHOCK_TURN ? [{ type: 'shock', shock: 'harvestFailure' }] : []));

  it('неурожай: выпуск зерна падает на время шока, потом шок снимается', () => {
    for (let t = SHOCK_TURN; t < SHOCK_TURN + harvest.turns; t++) {
      expect(r.states[t]!.metrics.output.grain!).toBeLessThan(0.7 * passive.states[t]!.metrics.output.grain!);
      expect(r.states[t]!.activeShocks.map((s) => s.id)).toContain('harvestFailure');
    }
    expect(r.states[SHOCK_TURN + harvest.turns]!.activeShocks).toEqual([]);
  });

  it('неизвестный шок — ошибка', () => {
    expect(() => run(1, () => [{ type: 'shock', shock: 'meteor' }])).toThrow(/meteor/);
  });
});

describe('рост цены топлива → ИЦП растёт', () => {
  const r = run(TURNS, (t) => (t === SHOCK_TURN ? [{ type: 'shock', shock: 'refineryAccident' }] : []));

  it('авария на НПЗ: цена производителей топлива выше уже в ходе шока', () => {
    expect(r.states[SHOCK_TURN + 1]!.market.fuel!.producerPrice).toBeGreaterThan(passive.states[SHOCK_TURN + 1]!.market.fuel!.producerPrice);
  });

  it('через 4+ хода ИЦП выше, чем без шока', () => {
    for (let t = SHOCK_TURN + 4; t <= TURNS; t++) expect(r.states[t]!.metrics.ppi).toBeGreaterThan(passive.states[t]!.metrics.ppi);
  });

  it('изменение ИЦП раскладывается по товарам', () => {
    for (let t = 1; t <= TURNS; t++) {
      const e = r.causes[t]!.find((c) => c.metric === 'ppi')!;
      expect(e.delta).toBeCloseTo(r.states[t]!.metrics.ppi - r.states[t - 1]!.metrics.ppi, 9);
      expect(e.causes.reduce((a, c) => a + c.value, 0)).toBeCloseTo(e.delta, 9);
    }
  });
});
