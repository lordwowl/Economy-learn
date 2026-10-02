import { describe, expect, it } from 'vitest';
import scenario from '../../data/scenarios/baseline.json';
import { getGameData } from '../../src/data';
import {
  buildingClusters,
  clusterOffsets,
  deficitLevel,
  deficitMark,
  dotCount,
  fitToView,
  MAX_DOTS_PER_DIRECTION,
  pathLength,
  pointAt,
  priceTrend,
  provinceDeficit,
  routePath,
  smoothPolygon,
  trendMark,
  type MapLayout,
} from '../../src/render/model';
import { run } from '../sim/helpers';

const layout = scenario.map as unknown as MapLayout;
const { buildings } = getGameData();

describe('тепловая карта дефицита', () => {
  it('уровни по порогам и знак, дублирующий цвет', () => {
    expect([0, 0.04, 0.05, 0.3, 0.9].map(deficitLevel)).toEqual([0, 0, 1, 2, 3]);
    expect(deficitMark(0)).toBe('');
    expect(deficitMark(3)).toBe('!!!');
  });

  it('дефицит провинции — наибольший по товарам', () => {
    const r = run(4, () => [], undefined, (sc) => {
      sc.routes.find((x) => x.id === 'centerSouth')!.lanes = 1;
    });
    const s = r.states[3]!;
    expect(provinceDeficit(s, 'south')).toBe(Math.max(...Object.values(s.metrics.provinceShortage.south!)));
    expect(provinceDeficit(s, 'south')).toBeGreaterThan(provinceDeficit(s, 'north'));
  });
});

describe('тренд цен', () => {
  it('без прошлого хода — flat; при росте цен — up со знаком ▲', () => {
    const r = run(8, (t) => (t === 2 ? [{ type: 'setTransfers', perCapita: 10 }] : []));
    expect(priceTrend(r.states[1]!, undefined, 'north')).toBe('flat');
    expect(priceTrend(r.states[7]!, r.states[6]!, 'north')).toBe('up');
    expect(trendMark('up')).toBe('▲');
    expect(trendMark('down')).toBe('▼');
  });
});

describe('здания на карте', () => {
  it('кластеры по типам в порядке buildings.json, со строящимися', () => {
    const r = run(1, () => [{ type: 'buildStorage', building: 'warehouse', province: 'north' }]);
    const clusters = buildingClusters(r.states[1]!, buildings, 'north');
    expect(clusters.map((c) => c.building)).toEqual(['farm', 'mill', 'bakery', 'warehouse']);
    expect(clusters.find((c) => c.building === 'warehouse')).toMatchObject({ ready: 0, underConstruction: 1, shape: 'triangle' });
    expect(clusters.find((c) => c.building === 'farm')!.ready).toBe(5);
  });

  it('смещения кластера: каждый ряд по центру, полные ряды — симметрично по вертикали', () => {
    const five = clusterOffsets(5, 10);
    expect(five).toHaveLength(5);
    expect(five.reduce((s, [x]) => s + x, 0)).toBeCloseTo(0, 9);
    expect(clusterOffsets(6, 10).reduce((s, [, y]) => s + y, 0)).toBeCloseTo(0, 9);
  });
});

describe('дороги и потоки', () => {
  it('путь дороги идёт через изгибы', () => {
    const path = routePath(layout, { id: 'northSouth', a: 'north', b: 'south' });
    expect(path).toHaveLength(3);
    expect(path[1]).toEqual(layout.routes.northSouth!.via[0]);
  });

  it('точка на пути: концы, середина по длине, сдвиг вбок перпендикулярен', () => {
    const path = [
      [0, 0],
      [10, 0],
    ] as const;
    expect(pathLength(path)).toBe(10);
    expect(pointAt(path, 0)).toEqual([0, 0]);
    expect(pointAt(path, 0.5)).toEqual([5, 0]);
    expect(pointAt(path, 1)).toEqual([10, 0]);
    expect(pointAt(path, 0.5, 2)).toEqual([5, 2]);
  });

  it('число точек растёт с потоком и ограничено', () => {
    expect(dotCount(0)).toBe(0);
    expect(dotCount(1)).toBe(1);
    expect(dotCount(100)).toBeGreaterThan(dotCount(30));
    expect(dotCount(1e9)).toBe(MAX_DOTS_PER_DIRECTION);
  });
});

describe('геометрия', () => {
  it('мягкий полигон: старт + по кривой на вершину, конец совпадает со стартом', () => {
    const cmds = smoothPolygon(layout.provinces.north!.polygon as never);
    expect(cmds).toHaveLength(layout.provinces.north!.polygon.length + 1);
    expect(cmds.at(-1)!.to).toEqual(cmds[0]!.to);
  });

  it('вписывание сохраняет пропорции и центрирует', () => {
    const fit = fitToView(800, 1000, 360, 640, 10);
    expect(fit.scale).toBeCloseTo(340 / 800, 9);
    expect(fit.offsetX).toBeCloseTo(10, 9);
    expect(fit.offsetY).toBeCloseTo((640 - 1000 * fit.scale) / 2, 9);
  });
});
