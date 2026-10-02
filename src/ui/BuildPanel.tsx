import type { GameData } from '../data';
import { stateFirmCost } from '../sim/step';
import { t, translate } from '../i18n';
import type { Action, WorldState } from '../sim';
import { Section } from './controls';
import { money, num } from './format';
import { provinceName, routeName } from './labels';

interface Props {
  state: WorldState;
  data: GameData;
  onDecide: (action: Action) => void;
  /** Что разрешено строить на уровне (id из buildings.json; по умолчанию — всё). */
  allowed?: readonly string[];
}

export function BuildPanel({ state, data, onDecide, allowed }: Props) {
  const can = (id: string | undefined) => id !== undefined && (allowed === undefined || allowed.includes(id));
  const lane = data.buildings.find((b) => b.kind === 'route' && can(b.id));
  const fleet = data.buildings.find((b) => b.kind === 'fleet' && can(b.id));
  const storages = data.buildings.filter((b) => b.kind === 'storage' && can(b.id));
  // Госпредприятия: НПЗ (государственный по данным) и, где уровень разрешает, частные здания в собственности государства.
  const stateFirms = data.buildings.filter((b) => b.kind === 'producer' && (allowed === undefined ? b.owner === 'state' : can(b.id)));
  const stateCarrier = state.logistics.carriers.find((c) => c.id === 'state');

  return (
    <div class="panel">
      {lane?.kind === 'route' && (
        <Section title={t('build.roads')}>
          {state.routes.map((route) => (
            <div class="build-row" key={route.id}>
              <div class="build-row__text">
                <strong>{routeName(state, route.id)}</strong>
                <span>{t('build.roadInfo', { lanes: route.lanes, capacity: num(lane.capacityPerLane * route.lanes) })}</span>
              </div>
              <button type="button" class="chip chip--primary" onClick={() => onDecide({ type: 'addRoadLane', route: route.id })}>
                {t('build.addLane')}
                <small>{t('build.cost', { cost: money(lane.costPerLength * route.length), turns: lane.buildTurns })}</small>
              </button>
            </div>
          ))}
        </Section>
      )}

      {!lane && !fleet && storages.length === 0 && stateFirms.length === 0 && <p class="section__hint">{t('build.closed')}</p>}

      {storages.length > 0 && (
        <Section title={t('build.storages')}>
          {storages.map((b) =>
            b.kind !== 'storage'
              ? null
              : state.provinces.map((p) => (
                  <div class="build-row" key={`${b.id}-${p.id}`}>
                    <div class="build-row__text">
                      <strong>{t('build.storage', { building: translate(b.nameKey), province: provinceName(state, p.id) })}</strong>
                      <span>{num(b.storageCapacity)}</span>
                    </div>
                    <button type="button" class="chip chip--primary" onClick={() => onDecide({ type: 'buildStorage', building: b.id, province: p.id })}>
                      +1
                      <small>{t('build.cost', { cost: money(b.cost), turns: b.buildTurns })}</small>
                    </button>
                  </div>
                )),
          )}
        </Section>
      )}

      {stateFirms.length > 0 && (
        <Section title={t('build.stateFirms')}>
          {stateFirms.map((b) =>
            b.kind !== 'producer'
              ? null
              : state.provinces.map((p) => (
                  <div class="build-row" key={`${b.id}-${p.id}`}>
                    <div class="build-row__text">
                      <strong>{t('build.storage', { building: translate(b.nameKey), province: provinceName(state, p.id) })}</strong>
                      <span>{t('build.stateFirmInfo', { capacity: num(b.capacity) })}</span>
                    </div>
                    <button type="button" class="chip chip--primary" onClick={() => onDecide({ type: 'buildStateFirm', building: b.id, province: p.id })}>
                      +1
                      <small>{t('build.cost', { cost: money(stateFirmCost(b, data.balance)), turns: b.buildTurns })}</small>
                    </button>
                  </div>
                )),
          )}
        </Section>
      )}

      {fleet?.kind === 'fleet' && (
        <Section title={t('build.fleet')}>
          <div class="build-row">
            <div class="build-row__text">
              <span>{t('build.fleetInfo', { fleet: stateCarrier?.fleet ?? 0, ordered: stateCarrier?.fleetOrdered ?? 0 })}</span>
            </div>
            <button type="button" class="chip chip--primary" onClick={() => onDecide({ type: 'buildStateFleet' })}>
              {t('build.addFleet')}
              <small>{t('build.cost', { cost: money(fleet.cost), turns: fleet.buildTurns })}</small>
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}
