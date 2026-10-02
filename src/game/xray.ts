// «Рентген товара» (GDD 6): из чего состоит цена и какой вклад даёт каждое звено цепочки.
// Компонента input.<товар> раскрывается в разложение цены этого товара (пропорционально), и так вниз по цепочке.
// Топливо — сквозной ресурс: не раскрывается, а показывается отдельной строкой. Σ частей = цена (тест).

import type { Breakdown } from '../sim/causes';
import type { WorldState } from '../sim';

export type XrayGroup = 'inputs' | 'labor' | 'fuel' | 'logistics' | 'markup' | 'taxes' | 'expectations' | 'policy' | 'other';

/** Порядок групп в полосе «из чего цена» (фиксированный — цвет следует за группой, а не за рангом). */
export const XRAY_GROUPS: readonly XrayGroup[] = ['inputs', 'labor', 'fuel', 'logistics', 'markup', 'taxes', 'expectations', 'other', 'policy'];

export interface XrayPart {
  /** Звено цепочки (товар), где возникла эта часть цены. */
  link: string;
  /** Компонента цены звена: wage, markup, input.fuel, … */
  ref: string;
  value: number;
  /** Глубина в цепочке: 0 — сам товар, 1 — его вход, … */
  depth: number;
}

export interface XrayResult {
  price: number;
  prevPrice: number | undefined;
  parts: XrayPart[];
  /** По группам; policy (субсидии, потолок) обычно отрицательна. */
  groups: { group: XrayGroup; value: number }[];
  /** Вклад звеньев (добавленная стоимость в каждом звене), от начала цепочки к товару; топливо — отдельно. */
  links: { link: string; value: number }[];
}

/** Предел раскрытия цепочки (защита от циклов в данных). */
const MAX_DEPTH = 6;

export function groupOf(ref: string, fuelGood: string): XrayGroup {
  if (ref === `input.${fuelGood}`) return 'fuel';
  if (ref.startsWith('input.')) return 'inputs';
  switch (ref) {
    case 'wage':
      return 'labor';
    case 'logistics':
      return 'logistics';
    case 'markup':
      return 'markup';
    case 'tax.sales':
      return 'taxes';
    case 'expectations':
      return 'expectations';
    case 'subsidy':
    case 'priceCeiling':
      return 'policy';
    default:
      return 'other';
  }
}

function marketBreakdown(state: WorldState, good: string, province: string | undefined): Breakdown | undefined {
  const m = state.market[good];
  if (!m) return undefined;
  return province ? (m.provinces[province]?.breakdown ?? m.breakdown) : m.breakdown;
}

function priceOf(state: WorldState | undefined, good: string, province: string | undefined): number | undefined {
  const m = state?.market[good];
  if (!m) return undefined;
  return province ? (m.provinces[province]?.price ?? m.price) : m.price;
}

/** Части цены товара, раскрытые по цепочке. province — рынок провинции, иначе средний по стране. */
export function expandChain(state: WorldState, good: string, province: string | undefined, fuelGood: string): XrayPart[] {
  const parts: XrayPart[] = [];
  const expand = (breakdown: Breakdown, link: string, scale: number, depth: number) => {
    for (const [ref, v] of Object.entries(breakdown)) {
      const value = v * scale;
      if (value === 0) continue;
      const input = ref.startsWith('input.') ? ref.slice('input.'.length) : undefined;
      const inner = input && input !== fuelGood && depth < MAX_DEPTH ? marketBreakdown(state, input, province) : undefined;
      const total = inner ? Object.values(inner).reduce((a, b) => a + b, 0) : 0;
      if (inner && total > 0) expand(inner, input!, value / total, depth + 1);
      else parts.push({ link, ref, value, depth });
    }
  };
  const root = marketBreakdown(state, good, province);
  if (root) expand(root, good, 1, 0);
  return parts;
}

export function xray(state: WorldState, prev: WorldState | undefined, good: string, province: string | undefined, fuelGood: string): XrayResult {
  const parts = expandChain(state, good, province, fuelGood);
  const groups = XRAY_GROUPS.map((group) => ({
    group,
    value: parts.filter((p) => groupOf(p.ref, fuelGood) === group).reduce((a, p) => a + p.value, 0),
  })).filter((g) => g.value !== 0);

  const depthOf = new Map<string, number>();
  for (const p of parts) depthOf.set(p.link, Math.max(depthOf.get(p.link) ?? 0, p.depth));
  const linkValue = new Map<string, number>();
  for (const p of parts) {
    const key = groupOf(p.ref, fuelGood) === 'fuel' ? fuelGood : p.link;
    linkValue.set(key, (linkValue.get(key) ?? 0) + p.value);
  }
  const links = [...linkValue.entries()]
    .map(([link, value]) => ({ link, value }))
    .sort((a, b) => (a.link === fuelGood ? 1 : b.link === fuelGood ? -1 : (depthOf.get(b.link) ?? 0) - (depthOf.get(a.link) ?? 0)));

  return { price: priceOf(state, good, province) ?? 0, prevPrice: priceOf(prev, good, province), parts, groups, links };
}
