import { useEffect, useRef, useState } from 'preact/hooks';
import type { Building, Scenario } from '../data/schemas';
import { t } from '../i18n';
import type { WorldMap } from '../render/WorldMap';
import type { WorldState } from '../sim';
import { provinceName } from './labels';

interface Props {
  layout: Scenario['map'];
  buildings: readonly Building[];
  state: WorldState;
  prev: WorldState | undefined;
}

/** Карта PixiJS: модуль грузится отдельным чанком при первом показе. */
export function MapView({ layout, buildings, state, prev }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<WorldMap | null>(null);
  const latest = useRef(state);
  latest.current = state;
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let disposed = false;
    import('../render/WorldMap')
      .then(({ WorldMap }) =>
        WorldMap.create(container.current!, { layout, buildings, provinceName: (id) => provinceName(latest.current, id) }),
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
  }, [layout, buildings]);

  useEffect(() => {
    if (status === 'ready') map.current?.update(state, prev);
  }, [state, prev, status]);

  return (
    <div class="map" ref={container} role="img" aria-label={t('game.mapLabel')}>
      {status === 'loading' && <p class="map__status">{t('game.mapLoading')}</p>}
      {status === 'failed' && <p class="map__status">{t('game.mapUnsupported')}</p>}
    </div>
  );
}
