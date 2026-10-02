import { useState } from 'preact/hooks';
import { LEVERS, type GameData, type Lever } from '../data';
import { decisionKey } from '../game/session';
import { t, translate } from '../i18n';
import type { Action, TaxKind, WorldState } from '../sim';
import { Section, Stepper } from './controls';
import { money, num, pct } from './format';
import { goodName, provinceName } from './labels';

/** Шаги и пределы рычагов (интерфейс, не формулы модели). */
const RATE = { step: 0.005, min: 0, max: 0.3 };
const TAX = { step: 0.01, min: 0, max: 0.5 };
const TRANSFERS = { step: 25, min: 0, max: 5000 };
const SUBSIDY = { step: 10, min: 0, max: 2000 };
const CEILING = { share: 0.9, stepShare: 0.02 };
const RESERVE_QUANTITY = { step: 50, min: 50, max: 1000 };
const TAXES: TaxKind[] = ['sales', 'profit', 'income'];

interface Props {
  state: WorldState;
  data: GameData;
  decisions: readonly Action[];
  onDecide: (action: Action) => void;
  /** Открытые на уровне рычаги (по умолчанию — все). */
  levers?: readonly Lever[];
}

export function PolicyPanel({ state, data, decisions, onDecide, levers = LEVERS }: Props) {
  const open = (lever: Lever) => levers.includes(lever);
  const decided = <A extends Action>(key: string) => decisions.find((d) => decisionKey(d) === key) as A | undefined;
  const g = state.government;
  const goods = data.goods.map((x) => x.id);
  const consumerGoods = Object.keys(data.balance.demand.goods);

  const keyRate = decided<Extract<Action, { type: 'setKeyRate' }>>('keyRate')?.rate ?? state.keyRate;
  const transfers = decided<Extract<Action, { type: 'setTransfers' }>>('transfers')?.perCapita ?? g.transfersPerCapita;

  return (
    <div class="panel">
      {open('keyRate') && (
        <Section title={t('policy.keyRate')} hint={t('policy.keyRateHint')}>
          <Stepper
            label={t('policy.keyRate')}
            value={keyRate}
            current={state.keyRate}
            {...RATE}
            format={(v) => pct(v)}
            onChange={(rate) => onDecide({ type: 'setKeyRate', rate })}
          />
        </Section>
      )}

      {open('taxes') && (
        <Section title={t('policy.taxes')}>
          <div class="grid">
            {TAXES.map((tax) => (
              <Stepper
                key={tax}
                label={translate(`policy.tax.${tax}`)}
                value={decided<Extract<Action, { type: 'setTax' }>>(`tax.${tax}`)?.rate ?? g.taxes[tax]}
                current={g.taxes[tax]}
                {...TAX}
                format={(v) => pct(v, 0)}
                onChange={(rate) => onDecide({ type: 'setTax', tax, rate })}
              />
            ))}
          </div>
        </Section>
      )}

      {open('transfers') && (
        <Section title={t('policy.transfers')}>
          <Stepper
            label={t('policy.transfers')}
            value={transfers}
            current={g.transfersPerCapita}
            {...TRANSFERS}
            format={(v) => money(v)}
            onChange={(perCapita) => onDecide({ type: 'setTransfers', perCapita })}
          />
        </Section>
      )}

      {open('subsidies') && (
        <Section title={t('policy.subsidies')} hint={t('policy.subsidyHint')}>
          <div class="grid">
            {goods.map((good) => {
              const announced = g.announcedSubsidies[good] ?? 0;
              return (
                <Stepper
                  key={good}
                  label={goodName(good)}
                  value={decided<Extract<Action, { type: 'setSubsidy' }>>(`subsidy.${good}`)?.perUnit ?? announced}
                  current={announced}
                  {...SUBSIDY}
                  format={(v) => money(v)}
                  onChange={(perUnit) => onDecide({ type: 'setSubsidy', good, perUnit })}
                />
              );
            })}
          </div>
        </Section>
      )}

      {open('priceCeilings') && (
        <Section title={t('policy.ceilings')} hint={t('policy.ceilingHint')}>
          {consumerGoods.map((good) => {
            const now = g.priceCeilings[good];
            const pending = decided<Extract<Action, { type: 'setPriceCeiling' }>>(`ceiling.${good}`);
            const value = pending ? pending.price : (now ?? null);
            const price = state.market[good]?.price ?? 0;
            return (
              <div class="ceiling" key={good}>
                {value === null ? (
                  <div class="ceiling__off">
                    <span>
                      {goodName(good)}: {t('policy.ceilingOff')}
                    </span>
                    <button type="button" class="chip" onClick={() => onDecide({ type: 'setPriceCeiling', good, price: Math.round(price * CEILING.share) })}>
                      {t('policy.ceilingSet')}
                    </button>
                  </div>
                ) : (
                  <div class="ceiling__on">
                    <Stepper
                      label={goodName(good)}
                      value={value}
                      {...(now !== undefined ? { current: now } : {})}
                      step={Math.max(1, Math.round(price * CEILING.stepShare))}
                      min={1}
                      max={price * 3}
                      format={(v) => money(v)}
                      onChange={(p) => onDecide({ type: 'setPriceCeiling', good, price: p })}
                    />
                    <button type="button" class="chip" onClick={() => onDecide({ type: 'setPriceCeiling', good, price: null })}>
                      {t('policy.ceilingRemove')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </Section>
      )}

      {open('reserve') && <ReservePolicy state={state} data={data} onDecide={onDecide} />}
      {levers.length === 0 && <p class="section__hint">{t('policy.closed')}</p>}
    </div>
  );
}

function ReservePolicy({ state, data, onDecide }: Omit<Props, 'decisions' | 'levers'>) {
  const [quantity, setQuantity] = useState(100);
  const provinces = state.provinces.filter((p) => state.reserve.storages.some((s) => s.ready && s.province === p.id));
  return (
    <Section title={t('policy.reserve')}>
      {provinces.length === 0 && <p class="section__hint">{t('policy.reserveEmpty')}</p>}
      {provinces.length > 0 && <Stepper label={t('policy.reserve')} value={quantity} {...RESERVE_QUANTITY} format={(v) => num(v)} onChange={setQuantity} />}
      {provinces.map((p) => {
        const goods = new Set(
          state.reserve.storages
            .filter((s) => s.ready && s.province === p.id)
            .flatMap((s) => {
              const b = data.buildings.find((x) => x.id === s.building);
              return b?.kind === 'storage' ? b.storedGoods : [];
            }),
        );
        return (
          <div class="reserve" key={p.id}>
            <h4 class="reserve__province">{provinceName(state, p.id)}</h4>
            {[...goods].map((good) => {
              const stock = state.reserve.stock[p.id]?.[good] ?? 0;
              return (
                <div class="reserve__row" key={good}>
                  <span>
                    {goodName(good)} · {t('policy.reserveStock', { stock: num(stock) })}
                  </span>
                  <button type="button" class="chip" onClick={() => onDecide({ type: 'reserveBuy', good, province: p.id, quantity })}>
                    {t('policy.reserveBuy', { quantity: num(quantity) })}
                  </button>
                  <button
                    type="button"
                    class="chip"
                    disabled={stock <= 0}
                    onClick={() => onDecide({ type: 'reserveRelease', good, province: p.id, quantity: Math.min(quantity, stock) })}
                  >
                    {t('policy.reserveRelease', { quantity: num(Math.min(quantity, stock)) })}
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </Section>
  );
}
