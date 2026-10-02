// Карта (GDD 7) на PixiJS: провинции с тепловой картой дефицита, дороги, здания-фигуры, бегущие точки потоков.
// Только читает состояние мира. Геометрия и цвета — в model.ts (тестируется без PixiJS).

import { Application, Container, Graphics, Text } from 'pixi.js';
import type { Building } from '../data/schemas';
import type { WorldState } from '../sim/state';
import {
  buildingClusters,
  clusterOffsets,
  COLORS,
  deficitLevel,
  deficitMark,
  dotCount,
  fitToView,
  pointAt,
  priceTrend,
  provinceDeficit,
  routePath,
  smoothPolygon,
  trendColor,
  trendMark,
  type BuildingCluster,
  type Fit,
  type MapLayout,
  type Point,
} from './model';

export interface WorldMapOptions {
  layout: MapLayout;
  buildings: readonly Building[];
  /** Название провинции по id (из i18n). */
  provinceName(id: string): string;
}

/** Размеры в виртуальных координатах раскладки. */
const SIZE = {
  padding: 12,
  icon: 22,
  iconSpacing: 56,
  clusterShift: 34,
  roadBase: 5,
  roadPerLane: 3,
  dashLength: 14,
  laneSide: 7,
  dotRadius: 5,
  bottleneckRadius: 18,
  hubRadius: 9,
  labelFont: 13,
  countFont: 11,
} as const;

/** Поля подложки подписи и высота строки подписей, экранные пиксели. */
const LABEL_PAD = 4;
const LINE = 20;

/** Секунд на проход точки по дороге. */
const DOT_TRAVEL_SECONDS = 3;

interface DotLane {
  path: Point[];
  count: number;
  color: number;
}

export class WorldMap {
  private readonly app: Application;
  private readonly world = new Container();
  private readonly provinces = new Graphics();
  private readonly roads = new Graphics();
  private readonly icons = new Graphics();
  private readonly dots = new Graphics();
  /** Подписи не масштабируются вместе с картой — остаются чёткими. */
  private readonly labels = new Container();
  private fit: Fit = { scale: 1, offsetX: 0, offsetY: 0 };
  private size = { width: 0, height: 0 };
  private lanes: DotLane[] = [];
  private phase = 0;
  private state: WorldState | undefined;
  private prev: WorldState | undefined;

  private constructor(
    app: Application,
    private readonly options: WorldMapOptions,
  ) {
    this.app = app;
    this.world.addChild(this.provinces, this.roads, this.icons, this.dots);
    app.stage.addChild(this.world, this.labels);
    app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
  }

  static async create(container: HTMLElement, options: WorldMapOptions): Promise<WorldMap> {
    const app = new Application();
    await app.init({
      resizeTo: container,
      antialias: true,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      preference: 'webgl',
    });
    app.canvas.setAttribute('role', 'img');
    container.appendChild(app.canvas);
    return new WorldMap(app, options);
  }

  update(state: WorldState, prev?: WorldState): void {
    this.state = state;
    this.prev = prev;
    this.relayout(true);
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
  }

  private relayout(force = false): void {
    const { width, height } = this.app.screen;
    if (!force && width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    const { layout } = this.options;
    this.fit = fitToView(layout.width, layout.height, width, height, SIZE.padding);
    this.world.scale.set(this.fit.scale);
    this.world.position.set(this.fit.offsetX, this.fit.offsetY);
    this.draw();
  }

  private toScreen([x, y]: Point): Point {
    return [this.fit.offsetX + x * this.fit.scale, this.fit.offsetY + y * this.fit.scale];
  }

  /** Подпись на светлой подложке: читается на любой заливке дефицита. */
  /** dy — сдвиг в экранных пикселях (подписи не масштабируются вместе с картой). */
  private label(text: string, at: Point, size: number = SIZE.labelFont, weight: '400' | '700' = '700', dy = 0): void {
    if (!text) return;
    const t = new Text({
      text,
      style: { fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', fontSize: size, fontWeight: weight, fill: COLORS.text, align: 'center' },
    });
    t.anchor.set(0.5);
    const plate = new Graphics()
      .roundRect(-t.width / 2 - LABEL_PAD, -t.height / 2 - LABEL_PAD / 2, t.width + 2 * LABEL_PAD, t.height + LABEL_PAD, LABEL_PAD)
      .fill({ color: COLORS.background, alpha: 0.85 });
    const group = new Container();
    group.addChild(plate, t);
    const [x, y] = this.toScreen(at);
    group.position.set(Math.round(x), Math.round(y + dy));
    this.labels.addChild(group);
  }

  private draw(): void {
    const state = this.state;
    if (!state) return;
    const { layout } = this.options;
    for (const child of this.labels.removeChildren()) child.destroy({ children: true });
    this.provinces.clear();
    this.roads.clear();
    this.icons.clear();

    // Провинции: заливка — уровень дефицита, подпись дублирует его знаком «!» и трендом цен ▲/▼.
    for (const province of state.provinces) {
      const shape = layout.provinces[province.id];
      if (!shape) continue;
      const level = deficitLevel(provinceDeficit(state, province.id));
      for (const cmd of smoothPolygon(shape.polygon)) {
        if (cmd.type === 'move') this.provinces.moveTo(cmd.to[0], cmd.to[1]);
        else this.provinces.quadraticCurveTo(cmd.control[0], cmd.control[1], cmd.to[0], cmd.to[1]);
      }
      this.provinces.closePath().fill({ color: COLORS.deficit[level] }).stroke({ width: 3, color: COLORS.provinceBorder, alpha: 0.6 });
      const trend = priceTrend(state, this.prev, province.id);
      const marks = [deficitMark(level), trendMark(trend)].filter(Boolean).join(' ');
      const [cx, cy] = shape.center;
      // Название и знаки — над зданиями: нижний край подписи на iconSpacing выше центра (в экранных пикселях).
      const top = -(SIZE.icon + SIZE.clusterShift / 2) * this.fit.scale - LINE * (marks ? 2 : 1);
      this.label(this.options.provinceName(province.id), [cx, cy], SIZE.labelFont, '700', top);
      if (marks) this.label(marks, [cx, cy], SIZE.labelFont + 2, '700', top + LINE);
    }

    // Узлы дорог.
    for (const province of state.provinces) {
      const hub = layout.provinces[province.id]?.hub;
      if (hub) this.icons.circle(hub[0], hub[1], SIZE.hubRadius).fill({ color: COLORS.background }).stroke({ width: 3, color: COLORS.road });
    }

    // Дороги: толщина — полосы; непостроенная — пунктир; узкое место — красный круг со знаком «!».
    this.lanes = [];
    for (const route of state.routes) {
      const path = routePath(layout, route);
      if (path.length < 2) continue;
      if (route.lanes <= 0) {
        this.dashed(path, COLORS.plannedRoad, 3);
        continue;
      }
      this.polyline(path, SIZE.roadBase + SIZE.roadPerLane * route.lanes, COLORS.road, 0.45);
      const metrics = state.metrics.routes[route.id];
      if (!metrics) continue;
      for (const d of metrics.directions) {
        const forward = d.from === route.a;
        const lanePath = forward ? path : [...path].reverse();
        this.lanes.push({ path: lanePath, count: dotCount(d.flow), color: trendColor(priceTrend(state, this.prev, d.to)) });
      }
      if (metrics.directions.some((d) => d.blocked > 0)) {
        const mid = pointAt(path, 0.5);
        this.roads.circle(mid[0], mid[1], SIZE.bottleneckRadius).fill({ color: COLORS.bottleneck }).stroke({ width: 2, color: 0xffffff });
        this.label('!', mid, SIZE.labelFont + 3);
      }
    }

    // Здания: фигура — тип (круг — ферма, квадрат — мельница, …), контур — стройка, число — сколько их.
    for (const province of state.provinces) {
      const shape = layout.provinces[province.id];
      if (!shape) continue;
      const clusters = buildingClusters(state, this.options.buildings, province.id);
      const offsets = clusterOffsets(clusters.length, SIZE.iconSpacing);
      clusters.forEach((cluster, i) => {
        const [ox, oy] = offsets[i]!;
        const at: Point = [shape.center[0] + ox, shape.center[1] + oy + SIZE.clusterShift / 2];
        this.drawIcon(cluster, at);
        const total = cluster.ready + cluster.underConstruction;
        const count = cluster.underConstruction > 0 ? `${cluster.ready}+${cluster.underConstruction}` : `×${total}`;
        this.label(count, at, SIZE.countFont, '400', SIZE.icon * this.fit.scale + LINE / 2);
      });
    }
  }

  private drawIcon(cluster: BuildingCluster, [x, y]: Point): void {
    const r = SIZE.icon;
    const g = this.icons;
    switch (cluster.shape) {
      case 'circle':
        g.circle(x, y, r * 0.85);
        break;
      case 'square':
        g.rect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
        break;
      case 'hexagon':
        g.regularPoly(x, y, r * 0.9, 6, Math.PI / 6);
        break;
      case 'diamond':
        g.regularPoly(x, y, r, 4);
        break;
      case 'triangle':
        g.regularPoly(x, y, r, 3);
        break;
      case 'triangleDown':
        g.regularPoly(x, y, r, 3, Math.PI);
        break;
    }
    const color = cluster.shape === 'triangle' || cluster.shape === 'triangleDown' ? COLORS.storage : COLORS.building;
    if (cluster.ready > 0) g.fill({ color }).stroke({ width: 2, color: 0xffffff });
    else g.stroke({ width: 3, color: COLORS.buildingConstruction });
  }

  private polyline(path: readonly Point[], width: number, color: number, alpha: number): void {
    this.roads.moveTo(path[0]![0], path[0]![1]);
    for (const p of path.slice(1)) this.roads.lineTo(p[0], p[1]);
    this.roads.stroke({ width, color, alpha, cap: 'round', join: 'round' });
  }

  private dashed(path: readonly Point[], color: number, width: number): void {
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1]!;
      const [x1, y1] = path[i]!;
      const length = Math.hypot(x1 - x0, y1 - y0);
      for (let d = 0; d < length; d += SIZE.dashLength * 2) {
        const a = d / length;
        const b = Math.min(1, (d + SIZE.dashLength) / length);
        this.roads.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a).lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
      }
    }
    this.roads.stroke({ width, color });
  }

  private tick(seconds: number): void {
    this.relayout();
    this.phase = (this.phase + seconds / DOT_TRAVEL_SECONDS) % 1;
    const g = this.dots;
    g.clear();
    for (const lane of this.lanes) {
      for (let i = 0; i < lane.count; i++) {
        const t = (this.phase + i / lane.count) % 1;
        const [x, y] = pointAt(lane.path, t, SIZE.laneSide);
        g.circle(x, y, SIZE.dotRadius);
      }
      if (lane.count > 0) g.fill({ color: lane.color }).stroke({ width: 1.5, color: 0xffffff });
    }
  }
}
