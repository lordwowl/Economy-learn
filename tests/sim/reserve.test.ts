import { describe, expect, it } from 'vitest';
import { getGameData } from '../../src/data';
import type { Reserve } from '../../src/sim/state';
import { freeSpace } from '../../src/sim/systems/reserve';
import { run, totalMoney, type ScenarioPatch } from './helpers';

const { buildings } = getGameData();
const warehouse = buildings.find((b) => b.id === 'warehouse')!;
const elevator = buildings.find((b) => b.id === 'elevator')!;
if (warehouse.kind !== 'storage' || elevator.kind !== 'storage') throw new Error('нет складов в данных');

describe('вместимость резерва', () => {
  const reserve = (stock: Record<string, number>): Reserve => ({
    storages: [
      { id: 'w', building: 'warehouse', province: 'p', ready: true },
      { id: 'e', building: 'elevator', province: 'p', ready: true },
      { id: 'x', building: 'warehouse', province: 'p', ready: false },
    ],
    stock: { p: stock },
  });

  it('зерно сначала идёт в элеватор, склад остаётся под остальное', () => {
    const r = reserve({ grain: elevator.storageCapacity });
    expect(freeSpace(r, buildings, 'p', 'bread')).toBe(warehouse.storageCapacity);
    expect(freeSpace(r, buildings, 'p', 'grain')).toBe(warehouse.storageCapacity);
  });

  it('недостроенный склад не считается; хлеб в элеватор не кладут', () => {
    const r = reserve({ bread: 100 });
    expect(freeSpace(r, buildings, 'p', 'bread')).toBe(warehouse.storageCapacity - 100);
    expect(freeSpace(r, buildings, 'p', 'grain')).toBe(elevator.storageCapacity + warehouse.storageCapacity - 100);
  });
});

describe('госрезерв в ходе симуляции', () => {
  it('склад строится за buildTurns и стоит денег из бюджета', () => {
    const r = run(4, (t) => (t === 1 ? [{ type: 'buildStorage', building: 'warehouse', province: 'south' }] : []));
    expect(r.states[1]!.government.spending.construction).toBeCloseTo(warehouse.cost, 9);
    expect(r.states[1]!.reserve.storages[0]!.ready).toBe(false);
    expect(r.states[1 + warehouse.buildTurns]!.reserve.storages[0]!.ready).toBe(true);
  });

  it('закупка: запас растёт не больше свободного места, бюджет платит', () => {
    const r = run(6, (t) =>
      t === 1
        ? [{ type: 'buildStorage', building: 'warehouse', province: 'north' }]
        : t === 4
          ? [{ type: 'reserveBuy', good: 'bread', province: 'north', quantity: 10_000 }]
          : [],
    );
    const stock = r.states[4]!.reserve.stock.north?.bread ?? 0;
    expect(stock).toBeGreaterThan(0);
    expect(stock).toBeLessThanOrEqual(warehouse.storageCapacity + 1e-9);
    expect(r.states[4]!.government.spending.reserve!).toBeGreaterThan(0);
    const start = totalMoney(r.states[0]!);
    for (const s of r.states) expect(totalMoney(s)).toBeCloseTo(start, 6);
  });

  describe('интервенция при дефиците на юге (одна полоса центр–юг)', () => {
    const patch: ScenarioPatch = (sc) => {
      sc.routes.find((x) => x.id === 'centerSouth')!.lanes = 1;
      sc.reserve.storages.push({ building: 'warehouse', province: 'south' });
      sc.reserve.stock.push({ province: 'south', good: 'bread', quantity: 400 });
    };
    const T = 4;
    const without = run(6, () => [], undefined, patch);
    const withRelease = run(6, (t) => (t === T ? [{ type: 'reserveRelease', good: 'bread', province: 'south', quantity: 400 }] : []), undefined, patch);

    it('дефицит хлеба на юге ниже, запас уменьшился, деньги — в бюджет', () => {
      const s = withRelease.states[T]!;
      expect(s.metrics.provinceShortage.south!.bread!).toBeLessThan(without.states[T]!.metrics.provinceShortage.south!.bread!);
      expect(s.reserve.stock.south!.bread!).toBeLessThan(400);
      expect(s.government.revenue.reserveSales!).toBeGreaterThan(0);
      expect(s.market.bread!.provinces.south!.breakdown.reserve!).toBeGreaterThan(0);
    });

    it('деньги − долги сохраняются', () => {
      const start = totalMoney(withRelease.states[0]!);
      for (const s of withRelease.states) expect(totalMoney(s)).toBeCloseTo(start, 6);
    });
  });
});
