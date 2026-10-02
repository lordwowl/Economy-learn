// Ряды показателей для графиков (GDD 7): из истории ходов сессии.

import type { WorldState } from '../sim';

export type ChartMetric = 'cpi' | 'ppi' | 'unemployment' | 'gdp' | 'keyRate' | 'wage' | 'budgetBalance' | 'debt';

export const CHART_METRICS: readonly ChartMetric[] = ['cpi', 'unemployment', 'ppi', 'keyRate', 'gdp', 'wage', 'budgetBalance', 'debt'];

/** Значение показателя на графике; доли — в процентах. */
export function metricValue(state: WorldState, metric: ChartMetric): number {
  switch (metric) {
    case 'cpi':
      return state.metrics.cpi;
    case 'ppi':
      return state.metrics.ppi;
    case 'unemployment':
      return state.metrics.unemployment * 100;
    case 'gdp':
      return state.metrics.gdp;
    case 'keyRate':
      return state.keyRate * 100;
    case 'wage':
      return state.wage;
    case 'budgetBalance':
      return state.metrics.budgetBalance;
    case 'debt':
      return state.government.debt;
  }
}

export function series(states: readonly WorldState[], metric: ChartMetric): { turns: number[]; values: number[] } {
  return { turns: states.map((s) => s.turn), values: states.map((s) => metricValue(s, metric)) };
}
