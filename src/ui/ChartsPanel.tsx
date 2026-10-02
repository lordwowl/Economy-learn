import { CHART_METRICS, series, type ChartMetric } from '../game/charts';
import { t, translate } from '../i18n';
import type { WorldState } from '../sim';
import { num } from './format';
import { LineChart } from './LineChart';

/** Знаков после запятой для показателя. */
const DIGITS: Record<ChartMetric, number> = { cpi: 1, ppi: 1, unemployment: 1, gdp: 0, keyRate: 1, wage: 2, budgetBalance: 0, debt: 0 };
/** Наименьший размах оси: ±1 пункт индекса, ±1 п.п.; для денег — доля от среднего значения. */
const MIN_SPAN: Record<ChartMetric, number | { share: number }> = {
  cpi: 2,
  ppi: 2,
  unemployment: 2,
  keyRate: 2,
  gdp: { share: 0.05 },
  wage: { share: 0.05 },
  budgetBalance: { share: 0.5 },
  debt: { share: 0.2 },
};
/** Сколько последних месяцев в таблице. */
const TABLE_ROWS = 12;

interface Props {
  states: readonly WorldState[];
  metric: ChartMetric;
  onMetric: (m: ChartMetric) => void;
  /** Без выбора показателя (график внутри «Почему?»). */
  compact?: boolean;
}

export function ChartsPanel({ states, metric, onMetric, compact = false }: Props) {
  const { turns, values } = series(states, metric);
  const title = translate(`chart.${metric}`);
  const spanRule = MIN_SPAN[metric];
  const scale = Math.max(1, values.reduce((a, v) => a + Math.abs(v), 0) / Math.max(1, values.length));
  const minSpan = typeof spanRule === 'number' ? spanRule : spanRule.share * scale;
  const tail = turns.map((turn, i) => ({ turn, value: values[i]! })).slice(-TABLE_ROWS);
  return (
    <div>
      {!compact && (
        <div class="chips" role="group" aria-label={t('charts.indicators')}>
          {CHART_METRICS.map((m) => (
            <button key={m} type="button" class={m === metric ? 'chip chip--active' : 'chip'} aria-pressed={m === metric} onClick={() => onMetric(m)}>
              {translate(`chart.short.${m}`)}
            </button>
          ))}
        </div>
      )}
      <h3 class="section__title">{title}</h3>
      {turns.length < 2 ? (
        <p class="section__hint">{t('chart.empty')}</p>
      ) : (
        <LineChart key={metric} title={title} turns={turns} values={values} digits={DIGITS[metric]} minSpan={minSpan} />
      )}
      <details class="chart-table">
        <summary>{t('chart.table')}</summary>
        <table>
          <thead>
            <tr>
              <th>{t('chart.turn')}</th>
              <th>{title}</th>
            </tr>
          </thead>
          <tbody>
            {tail.map((r) => (
              <tr key={r.turn}>
                <td>{r.turn}</td>
                <td>{num(r.value, DIGITS[metric])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
