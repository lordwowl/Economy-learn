import type { GameData } from '../data';
import { contextFromState, formatWhyLine, why } from '../game/explain';
import { xray, type XrayGroup } from '../game/xray';
import { t, translate } from '../i18n';
import type { CauseEvent } from '../sim/causes';
import type { WorldState } from '../sim';
import { arrow, money, pct, signed } from './format';
import { goodName, provinceName } from './labels';

/** Цвет группы фиксирован (следует за группой, а не за её местом в рейтинге). */
const GROUP_COLOR: Record<XrayGroup, string> = {
  inputs: 'var(--series-1)',
  labor: 'var(--series-2)',
  fuel: 'var(--series-3)',
  logistics: 'var(--series-4)',
  markup: 'var(--series-5)',
  taxes: 'var(--series-6)',
  expectations: 'var(--series-7)',
  other: 'var(--series-other)',
  policy: 'var(--series-policy)',
};

interface Props {
  state: WorldState;
  prev: WorldState | undefined;
  causes: readonly CauseEvent[];
  data: GameData;
  good: string;
  province: string | undefined;
  onSelect: (good: string, province: string | undefined) => void;
}

export function XrayView({ state, prev, causes, data, good, province, onSelect }: Props) {
  const fuel = data.balance.logistics.fuelGood;
  const x = xray(state, prev, good, province, fuel);
  const positive = x.groups.filter((g) => g.value > 0);
  const gross = positive.reduce((a, g) => a + g.value, 0);
  const maxLink = Math.max(...x.links.map((l) => Math.abs(l.value)), 1e-9);
  const change = x.prevPrice ? x.price / x.prevPrice - 1 : 0;
  const metric = province ? `price.${good}.${province}` : `price.${good}`;
  const event = causes.find((c) => c.metric === metric);
  const lines = event && Math.abs(event.delta) > 1e-9 ? why(event, contextFromState(state), 3) : [];

  return (
    <div class="xray">
      <div class="chips" role="group" aria-label={t('charts.xray')}>
        {data.goods.map((g) => (
          <button key={g.id} type="button" class={g.id === good ? 'chip chip--active' : 'chip'} aria-pressed={g.id === good} onClick={() => onSelect(g.id, province)}>
            {goodName(g.id)}
          </button>
        ))}
      </div>
      <div class="chips" role="group">
        {[undefined, ...state.provinces.map((p) => p.id)].map((id) => (
          <button key={id ?? 'all'} type="button" class={id === province ? 'chip chip--active' : 'chip'} aria-pressed={id === province} onClick={() => onSelect(good, id)}>
            {id ? provinceName(state, id) : t('xray.country')}
          </button>
        ))}
      </div>

      <div class="xray__price">
        <strong>{t('xray.price', { value: money(x.price) })}</strong>
        {x.prevPrice !== undefined && <span>{t('xray.change', { arrow: arrow(change), change: `${signed(change * 100)}%` })}</span>}
      </div>

      <h3 class="section__title">{t('xray.composition')}</h3>
      <div class="xray__bar" aria-hidden="true">
        {positive.map((g) => (
          <div key={g.group} class="xray__segment" style={{ width: `${(g.value / gross) * 100}%`, background: GROUP_COLOR[g.group] }} />
        ))}
      </div>
      <ul class="xray__legend">
        {x.groups.map((g) => (
          <li key={g.group} class="xray__row">
            <span
              class={g.group === 'policy' ? 'xray__swatch xray__swatch--policy' : 'xray__swatch'}
              style={g.group === 'policy' ? undefined : { background: GROUP_COLOR[g.group] }}
            />
            <span>{translate(`xray.group.${g.group}`)}</span>
            <span>{g.value < 0 ? `▼ ${money(g.value)}` : money(g.value)}</span>
            <span class="xray__share">{pct(x.price > 0 ? g.value / x.price : 0, 0)}</span>
          </li>
        ))}
      </ul>

      <h3 class="section__title">{t('xray.chain')}</h3>
      <p class="section__hint">{t('xray.chainHint')}</p>
      {x.links.map((l) => (
        <div key={l.link} class="xray__link">
          <span>{l.link === fuel ? t('xray.fuelLink', { good: goodName(fuel) }) : goodName(l.link)}</span>
          <div class="xray__link-bar" style={{ width: `${(Math.abs(l.value) / maxLink) * 100}%` }} />
          <span>{money(l.value)}</span>
        </div>
      ))}

      <h3 class="section__title">{t('xray.changed')}</h3>
      {lines.length === 0 ? (
        <p class="section__hint">{t('xray.noChange')}</p>
      ) : (
        <ul class="why">
          {lines.map((l) => (
            <li key={l.ref} class={`why__line why__line--${l.direction}`}>
              {formatWhyLine(l)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
