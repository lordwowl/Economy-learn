import { useEffect, useRef, useState } from 'preact/hooks';
import type uPlotType from 'uplot';
import { t } from '../i18n';
import { num } from './format';

interface Props {
  title: string;
  turns: readonly number[];
  values: readonly number[];
  digits: number;
  /** Наименьший размах оси Y: мелкие колебания не выглядят обвалом. */
  minSpan: number;
}

const HEIGHT = 200;
/** Поле над и под данными, доля размаха. */
const PAD = 0.1;

/** Знаков после запятой, чтобы подписи делений не повторялись. */
function decimalsFor(step: number, digits: number): number {
  return step > 0 ? Math.max(digits, Math.ceil(-Math.log10(step))) : digits;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Один показатель во времени: линия 2px, курсор с значением в легенде uPlot, без второй оси. */
export function LineChart({ title, turns, values, digits, minSpan }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlotType | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    import('./uplot').then(({ default: uPlot }) => {
      if (disposed || !box.current) return;
      const fg = cssVar('--fg');
      const grid = cssVar('--grid');
      const options: uPlotType.Options = {
        width: box.current.clientWidth,
        height: HEIGHT,
        scales: {
          x: { time: false },
          y: {
            range: (_u, min, max) => {
              const mid = (min + max) / 2;
              const half = (Math.max(max - min, minSpan) / 2) * (1 + PAD);
              return [mid - half, mid + half];
            },
          },
        },
        cursor: { drag: { x: false, y: false } },
        legend: { live: true },
        series: [
          { label: t('chart.turn'), value: (_u, v) => (v == null ? '—' : String(v)) },
          {
            label: title,
            stroke: cssVar('--series-1'),
            width: 2,
            points: { show: true, size: 6 },
            value: (_u, v) => (v == null ? '—' : num(v, digits)),
          },
        ],
        axes: [
          { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { show: false }, incrs: [1, 2, 3, 6, 12] },
          { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { show: false }, values: (_u, vals) => {
              const step = vals.length > 1 ? Math.abs(vals[1]! - vals[0]!) : 0;
              return vals.map((v) => num(v, decimalsFor(step, digits)));
            },
            size: 60,
          },
        ],
      };
      plot.current = new uPlot(options, [[...turns], [...values]], box.current);
      setReady(true);
      observer = new ResizeObserver(() => {
        if (box.current && plot.current) plot.current.setSize({ width: box.current.clientWidth, height: HEIGHT });
      });
      observer.observe(box.current);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [title, digits, minSpan]);

  useEffect(() => {
    plot.current?.setData([[...turns], [...values]]);
  }, [turns, values, ready]);

  return (
    <div class="chart" ref={box} role="img" aria-label={title}>
      {!ready && <p class="section__hint">{t('chart.loading')}</p>}
    </div>
  );
}
