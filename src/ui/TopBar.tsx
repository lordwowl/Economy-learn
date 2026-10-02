import { t } from '../i18n';
import type { WorldState } from '../sim';
import { arrow, money, num, pct, signed, signedMoney } from './format';

export type TopMetric = 'cpi' | 'unemployment' | 'budget.balance' | 'trust';

interface Props {
  state: WorldState;
  prev: WorldState | undefined;
  onWhy: (metric: TopMetric) => void;
}

/** Верхняя панель (GDD 7): ИПЦ, безработица, бюджет, доверие. Нажатие — «Почему?». */
export function TopBar({ state, prev, onWhy }: Props) {
  const m = state.metrics;
  const cpiChange = prev ? m.cpi / prev.metrics.cpi - 1 : 0;
  const uChange = prev ? m.unemployment - prev.metrics.unemployment : 0;
  const tiles: { metric: TopMetric; title: string; value: string; note: string }[] = [
    { metric: 'cpi', title: t('top.cpi'), value: num(m.cpi, 1), note: `${arrow(cpiChange)} ${signed(cpiChange * 100)}%` },
    { metric: 'unemployment', title: t('top.unemployment'), value: pct(m.unemployment), note: `${arrow(uChange)} ${signed(uChange * 100)}` },
    { metric: 'budget.balance', title: t('top.budget'), value: signedMoney(m.budgetBalance), note: t('top.debt', { value: money(state.government.debt) }) },
    { metric: 'trust', title: t('top.trust'), value: pct(state.expectations.trust, 0), note: '' },
  ];
  return (
    <div class="topbar" title={t('top.whyHint')}>
      {tiles.map((tile) => (
        <button type="button" class="tile" key={tile.metric} onClick={() => onWhy(tile.metric)}>
          <span class="tile__title">{tile.title}</span>
          <span class="tile__value">{tile.value}</span>
          {tile.note && <span class="tile__note">{tile.note}</span>}
        </button>
      ))}
    </div>
  );
}
