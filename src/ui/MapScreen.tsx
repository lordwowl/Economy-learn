import { useEffect, useRef, useState } from 'preact/hooks';
import scenarioRaw from '../../data/scenarios/baseline.json';
import { getGameData, loadScenario } from '../data';
import { t, translate } from '../i18n';
import type { WorldMap } from '../render/WorldMap';
import { createInitialState, Rng, step, type WorldState } from '../sim';

/** Временный экран карты (M7): базовый сценарий и кнопка хода. Полный интерфейс — в M8. */
const SEED = 42;

interface Sim {
  state: WorldState;
  prev: WorldState | undefined;
}

export function MapScreen({ onBack }: { onBack: () => void }) {
  const data = getGameData();
  const scenario = useRef(loadScenario(scenarioRaw, data));
  const rng = useRef(new Rng(SEED));
  const [sim, setSim] = useState<Sim>(() => ({ state: createInitialState(data, scenario.current), prev: undefined }));
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<WorldMap | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let disposed = false;
    import('../render/WorldMap')
      .then(({ WorldMap }) =>
        WorldMap.create(container.current!, {
          layout: scenario.current.map,
          buildings: data.buildings,
          provinceName: (id) => translate(sim.state.provinces.find((p) => p.id === id)?.nameKey ?? id),
        }),
      )
      .then((created) => {
        if (disposed) return created.destroy();
        map.current = created;
        setStatus('ready');
      })
      .catch(() => setStatus('failed'));
    return () => {
      disposed = true;
      map.current?.destroy();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (status === 'ready') map.current?.update(sim.state, sim.prev);
  }, [sim, status]);

  const nextTurn = () => setSim(({ state }) => ({ state: step(state, [], rng.current, data).state, prev: state }));
  const m = sim.state.metrics;

  return (
    <div class="map-screen">
      <header class="map-bar">
        <button type="button" class="map-bar__back" onClick={onBack}>
          {t('map.back')}
        </button>
        <span class="map-bar__stat">{t('map.turn', { turn: sim.state.turn })}</span>
        <span class="map-bar__stat">{t('map.cpi', { value: m.cpi.toFixed(1) })}</span>
        <span class="map-bar__stat">{t('map.unemployment', { value: (m.unemployment * 100).toFixed(1) })}</span>
        <button type="button" class="map-bar__next" onClick={nextTurn}>
          {t('map.nextTurn')}
        </button>
      </header>
      <div class="map-canvas" ref={container} aria-label={t('map.label')}>
        {status === 'loading' && <p class="map-status">{t('map.loading')}</p>}
        {status === 'failed' && <p class="map-status">{t('map.unsupported')}</p>}
      </div>
      <details class="map-legend">
        <summary>{t('map.legend.title')}</summary>
        <ul>
          <li>{t('map.legend.deficit')}</li>
          <li>{t('map.legend.trend')}</li>
          <li>{t('map.legend.bottleneck')}</li>
          <li>{t('map.legend.shapes')}</li>
          <li>{t('map.legend.roads')}</li>
        </ul>
      </details>
    </div>
  );
}
