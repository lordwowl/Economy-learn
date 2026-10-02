// Спрос домохозяйств (GDD 5.5).

import type { Balance } from '../../data/schemas';
import type { GoodId, Households, ProvinceMarket } from '../state';
import { clamp } from '../units';

/** s = s0 − k_r × (ставка − нейтральная), в [0, 1]. */
export function spendingShare(rate: number, demand: Balance['demand']): number {
  return clamp(demand.baseSpendingShare - demand.rateSensitivity * (rate - demand.neutralRate), 0, 1);
}

export interface HouseholdPlan {
  /** Бюджет на покупки за ход: s × B. */
  budget: number;
  /** Желаемые количества после нормализации к бюджету. */
  quantities: Record<GoodId, number>;
}

/**
 * Q_i = base_i × N × (P_i / P_ref_i)^ε_i × (s×B / N / B_ref)^η_i, затем нормализация к бюджету:
 * если стоимость корзины больше s×B, сначала оплачивается минимум потребления, остальное урезается пропорционально.
 */
export function planHouseholdPurchases(
  households: Households,
  rate: number,
  market: Record<GoodId, ProvinceMarket>,
  demand: Balance['demand'],
): HouseholdPlan {
  const budget = spendingShare(rate, demand) * Math.max(0, households.cash);
  const n = households.population;
  const ref = households.referenceSpendingPerCapita;
  const income = ref > 0 ? budget / n / ref : 0;

  const wanted: Record<GoodId, number> = {};
  const minimum: Record<GoodId, number> = {};
  let cost = 0;
  let minimumCost = 0;
  for (const [good, params] of Object.entries(demand.goods)) {
    const m = market[good];
    if (!m || m.price <= 0) continue;
    const base = params.basePerCapita * n;
    const min = params.minShareOfBase * base;
    const q = Math.max(min, base * (m.price / m.referencePrice) ** params.priceElasticity * income ** params.incomeElasticity);
    wanted[good] = q;
    minimum[good] = min;
    cost += q * m.price;
    minimumCost += min * m.price;
  }

  if (cost <= budget) return { budget, quantities: wanted };

  const quantities: Record<GoodId, number> = {};
  if (minimumCost >= budget) {
    const k = minimumCost > 0 ? budget / minimumCost : 0;
    for (const good of Object.keys(wanted)) quantities[good] = (minimum[good] ?? 0) * k;
  } else {
    const k = (budget - minimumCost) / (cost - minimumCost);
    for (const [good, q] of Object.entries(wanted)) {
      const min = minimum[good] ?? 0;
      quantities[good] = min + (q - min) * k;
    }
  }
  return { budget, quantities };
}
