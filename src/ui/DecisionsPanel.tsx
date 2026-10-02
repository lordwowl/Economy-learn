import type { GameData } from '../data';
import { pendingItems } from '../game/pending';
import { t } from '../i18n';
import type { Action, WorldState } from '../sim';
import { describeDecision, describePending } from './labels';

interface Props {
  state: WorldState;
  data: GameData;
  decisions: readonly Action[];
  onRemove: (index: number) => void;
}

/** Решения этого месяца (можно отменить до хода) и то, что уже «в пути». */
export function DecisionsPanel({ state, data, decisions, onRemove }: Props) {
  const pending = pendingItems(state);
  return (
    <div class="decisions">
      <h3 class="decisions__title">{t('decisions.title')}</h3>
      {decisions.length === 0 && <p class="section__hint">{t('decisions.empty')}</p>}
      <ul class="decisions__list">
        {decisions.map((d, i) => (
          <li key={i} class="decisions__item">
            <span>{describeDecision(d, state, data)}</span>
            <button type="button" class="chip" onClick={() => onRemove(i)}>
              {t('decisions.cancel')}
            </button>
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <>
          <h3 class="decisions__title">⏳ {t('pending.title')}</h3>
          <ul class="decisions__list">
            {pending.map((p, i) => (
              <li key={i} class="decisions__item decisions__item--pending">
                {describePending(p, state)}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
