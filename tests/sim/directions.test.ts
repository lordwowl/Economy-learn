// «Честность» модели (CLAUDE.md): направления эффектов. Ставка и потолок — в step.test и ceiling.test.
import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { Rng, step } from '../../src/sim';
import { baseline, run, SEED } from './helpers';

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

describe('авария на НПЗ', () => {
  const r = run(TURNS, (t) => (t === SHOCK_TURN ? [{ type: 'shock', shock: 'refineryAccident' }] : []));

  it('авария на НПЗ: цена производителей топлива выше уже в ходе шока', () => {
    expect(r.states[SHOCK_TURN + 1]!.market.fuel!.producerPrice).toBeGreaterThan(passive.states[SHOCK_TURN + 1]!.market.fuel!.producerPrice);
  });

  it('изменение ИЦП раскладывается по товарам', () => {
    for (let t = 1; t <= TURNS; t++) {
      const e = r.causes[t]!.find((c) => c.metric === 'ppi')!;
      expect(e.delta).toBeCloseTo(r.states[t]!.metrics.ppi - r.states[t - 1]!.metrics.ppi, 9);
      expect(e.causes.reduce((a, c) => a + c.value, 0)).toBeCloseTo(e.delta, 9);
    }
  });
});

// Чистый канал издержек: НПЗ резко поднимают наценку — топливо дорожает, а дефицита и спада нет.
// (Авария на НПЗ ещё и останавливает производство без топлива: спад тянет остальные цены вниз и смешивает эффекты.)
describe('дорогое топливо → ИЦП и цены по цепочке растут', () => {
  const PRICE_TURN = 2;
  const data = getGameData();
  const rng = new Rng(SEED);
  const states = [baseline(data)];
  for (let t = 1; t <= 6; t++) {
    const prev = structuredClone(states[t - 1]!);
    if (t === PRICE_TURN) for (const f of prev.firms) if (f.building === 'refinery') f.markup = data.balance.firms.markupMax;
    states.push(step(prev, [], rng, data).state);
  }

  it('ИЦП выше уже в ходе подорожания и в следующие месяцы', () => {
    for (let t = PRICE_TURN; t <= 6; t++) expect(states[t]!.metrics.ppi).toBeGreaterThan(passive.states[t]!.metrics.ppi);
  });

  it('через 2+ хода дорожают зерно, мука и хлеб: топливо входит в каждое звено', () => {
    for (let t = PRICE_TURN + 2; t <= 6; t++) {
      for (const good of ['grain', 'flour', 'bread'])
        expect(states[t]!.market[good]!.producerPrice).toBeGreaterThan(passive.states[t]!.market[good]!.producerPrice);
    }
  });
});
