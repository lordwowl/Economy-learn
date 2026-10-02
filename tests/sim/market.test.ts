import { describe, expect, it } from 'vitest';
import { clearMarket } from '../../src/sim/market';

const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe('clearMarket', () => {
  it('избыток предложения: все заявки исполнены, продавцы продают одну долю склада', () => {
    const r = clearMarket(
      [
        { seller: 'a', price: 10, quantity: 100 },
        { seller: 'b', price: 10, quantity: 300 },
      ],
      [{ buyer: 'x', quantity: 200, budget: 1e9 }],
    );
    expect(r.quantity).toBeCloseTo(200);
    expect(r.sold.get('a')).toBeCloseTo(50);
    expect(r.sold.get('b')).toBeCloseTo(150);
    expect(r.unmetBySupply).toBe(0);
  });

  it('нехватка: покупатели получают одинаковую долю заявки', () => {
    const r = clearMarket(
      [{ seller: 'a', price: 5, quantity: 60 }],
      [
        { buyer: 'x', quantity: 100, budget: 1e9 },
        { buyer: 'y', quantity: 20, budget: 1e9 },
      ],
    );
    expect(r.bought.get('x')).toBeCloseTo(50);
    expect(r.bought.get('y')).toBeCloseTo(10);
    expect(r.unmetBySupply).toBeCloseTo(60);
  });

  it('бюджет ограничивает покупку', () => {
    const r = clearMarket([{ seller: 'a', price: 4, quantity: 100 }], [{ buyer: 'x', quantity: 50, budget: 80 }]);
    expect(r.bought.get('x')).toBeCloseTo(20);
    expect(r.paid.get('x')).toBeCloseTo(80);
  });

  it('деньги сохраняются: Σ оплат = Σ выручки продавцов', () => {
    const offers = [
      { seller: 'a', price: 3, quantity: 40 },
      { seller: 'b', price: 7, quantity: 10 },
    ];
    const r = clearMarket(offers, [
      { buyer: 'x', quantity: 30, budget: 50 },
      { buyer: 'y', quantity: 30, budget: 1e9 },
    ]);
    const revenue = offers.reduce((s, o) => s + (r.sold.get(o.seller) ?? 0) * o.price, 0);
    expect(sum(r.paid)).toBeCloseTo(revenue, 9);
    expect(sum(r.bought)).toBeCloseTo(sum(r.sold), 9);
  });

  it('пустой рынок', () => {
    const r = clearMarket([], [{ buyer: 'x', quantity: 10, budget: 100 }]);
    expect(r.quantity).toBe(0);
    expect(r.unmetBySupply).toBe(10);
  });
});
