import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import { Rng, step } from '../../src/sim';
import { sumBreakdown } from '../../src/sim/causes';
import { baseline, run, totalMoney } from './helpers';

const TURNS = 36;
const passive = run(TURNS);
const data = getGameData();
const recipes = new Map(data.recipes.map((r) => [r.id, r]));

describe('step: чистота и детерминизм', () => {
  it('не меняет входное состояние', () => {
    const start = baseline();
    const copy = structuredClone(start);
    step(start, [{ type: 'setKeyRate', rate: 0.1 }], new Rng(1), data);
    expect(start).toEqual(copy);
  });

  it('одинаковые seed и действия → одинаковый результат', () => {
    const again = run(TURNS);
    expect(again.states.at(-1)).toEqual(passive.states.at(-1));
  });

  it('состояние сериализуется в JSON без потерь', () => {
    const last = passive.states.at(-1)!;
    expect(JSON.parse(JSON.stringify(last))).toEqual(last);
  });
});

describe('инварианты (GDD 5.15)', () => {
  it('деньги сохраняются (кредита и эмиссии в M3 нет)', () => {
    const start = totalMoney(passive.states[0]!);
    for (const s of passive.states) expect(totalMoney(s)).toBeCloseTo(start, 6);
  });

  it('запасы и деньги ≥ 0', () => {
    for (const s of passive.states) {
      for (const f of s.firms) {
        expect(f.cash, f.id).toBeGreaterThanOrEqual(-1e-9);
        for (const [good, q] of Object.entries(f.inventory)) expect(q, `${f.id} ${good}`).toBeGreaterThanOrEqual(-1e-9);
      }
      for (const p of s.provinces) expect(p.households.cash).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('выпуск ≤ мощности', () => {
    for (const s of passive.states.slice(1)) {
      for (const f of s.firms) expect(f.lastRuns).toBeLessThanOrEqual(f.capacity + 1e-9);
    }
  });

  it('занятость ≤ рабочей силы', () => {
    for (const s of passive.states) expect(s.metrics.unemployment).toBeGreaterThanOrEqual(-1e-9);
  });

  it('выпуск по рецептам: на 1 ед. хлеба уходит 0.5 муки', () => {
    const s = passive.states[5]!;
    const bakeries = s.firms.filter((f) => f.building === 'bakery');
    const runs = bakeries.reduce((a, f) => a + f.lastRuns, 0);
    expect(s.metrics.output.bread).toBeCloseTo(runs * recipes.get('bread')!.output.amount, 9);
  });
});

describe('причинный журнал', () => {
  it('Σ компонент цены = цена (фирмы и рынок)', () => {
    for (const s of passive.states) {
      for (const f of s.firms) expect(sumBreakdown(f.breakdown)).toBeCloseTo(f.price, 9);
      for (const m of Object.values(s.market)) expect(sumBreakdown(m.breakdown)).toBeCloseTo(m.price, 9);
    }
  });

  it('Σ вкладов = изменение метрики для каждого события', () => {
    for (const events of passive.causes) {
      for (const e of events) {
        expect(e.causes.reduce((a, c) => a + c.value, 0), e.metric).toBeCloseTo(e.delta, 9);
      }
    }
  });

  it('изменение цены хлеба совпадает с событием price.bread', () => {
    for (let t = 1; t <= TURNS; t++) {
      const e = passive.causes[t]!.find((c) => c.metric === 'price.bread');
      const delta = passive.states[t]!.market.bread!.price - passive.states[t - 1]!.market.bread!.price;
      expect(e?.delta ?? 0).toBeCloseTo(delta, 9);
    }
  });

  it('изменение ИПЦ раскладывается по товарам', () => {
    const t = 12;
    const e = passive.causes[t]!.find((c) => c.metric === 'cpi')!;
    expect(e.delta).toBeCloseTo(passive.states[t]!.metrics.cpi - passive.states[t - 1]!.metrics.cpi, 9);
    const allowed = Object.keys(data.balance.cpiWeights).map((g) => `price.${g}`);
    for (const c of e.causes) expect(allowed).toContain(c.ref);
  });
});

describe('устойчивость базового сценария без вмешательства', () => {
  it(`за ${TURNS} ходов нет спирали: ИПЦ, безработица и снабжение в разумных пределах`, () => {
    for (const s of passive.states) {
      expect(s.metrics.cpi).toBeGreaterThan(90);
      expect(s.metrics.cpi).toBeLessThan(115);
      expect(s.metrics.unemployment).toBeLessThan(0.15);
      expect(s.metrics.shortage.bread ?? 0).toBeLessThan(0.05);
    }
  });
});

describe('направление эффектов', () => {
  const HIKE_TURN = 3;
  const hike = run(12, (t) => (t === HIKE_TURN ? [{ type: 'setKeyRate', rate: 0.12 }] : []));
  const spending = (r: typeof hike, t: number) => r.states[t]!.metrics.householdSpending;

  it('ставка ↑ → спрос не меняется раньше первого лага (2 мес)', () => {
    for (let t = 1; t < HIKE_TURN + 2; t++) expect(spending(hike, t)).toBeCloseTo(spending(passive, t), 6);
  });

  it('ставка ↑ → спрос ниже через 2–4 хода', () => {
    for (let t = HIKE_TURN + 2; t <= HIKE_TURN + 4; t++) expect(spending(hike, t)).toBeLessThan(spending(passive, t));
  });

  it('ставка ↑ → через полгода цены ниже, безработица выше, чем без повышения', () => {
    const t = HIKE_TURN + 6;
    expect(hike.states[t]!.metrics.cpi).toBeLessThan(passive.states[t]!.metrics.cpi);
    expect(hike.states[t]!.metrics.unemployment).toBeGreaterThan(passive.states[t]!.metrics.unemployment);
  });
});
