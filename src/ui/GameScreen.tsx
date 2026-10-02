import { useMemo, useState } from 'preact/hooks';
import scenarioRaw from '../../data/scenarios/baseline.json';
import { getGameData, loadScenario } from '../data';
import { contextFromState, formatWhyLine, metricLabel, why } from '../game/explain';
import { addDecision, createSession, currentState, decisionKey, endTurn, fastForward, previousState, removeDecision, type Session } from '../game/session';
import { monthSummary, type SummaryItem } from '../game/summary';
import { t } from '../i18n';
import type { Action, WorldState } from '../sim';
import type { ChartMetric } from '../game/charts';
import { BuildPanel } from './BuildPanel';
import { ChartsPanel } from './ChartsPanel';
import { DecisionsPanel } from './DecisionsPanel';
import { Modal } from './controls';
import { describeSummary } from './labels';
import { MapView } from './MapView';
import { PolicyPanel } from './PolicyPanel';
import { TopBar, type TopMetric } from './TopBar';
import { XrayView } from './XrayView';

/** График, который открывается из «Почему?» у показателя верхней панели. */
const TOP_CHART: Partial<Record<TopMetric, ChartMetric>> = { cpi: 'cpi', unemployment: 'unemployment', 'budget.balance': 'budgetBalance' };

const SEED = 42;
const FAST_FORWARD_TURNS = 3;

type Tab = 'policy' | 'build' | 'charts';
type Dialog = { kind: 'summary'; turn: number; items: SummaryItem[] } | { kind: 'why'; metric: TopMetric } | null;

/** Решение, которое ничего не меняет (вернули рычаг к текущему значению), — убирает прежнее решение. */
function isNoop(action: Action, state: WorldState): boolean {
  const g = state.government;
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  switch (action.type) {
    case 'setKeyRate':
      return same(action.rate, state.keyRate);
    case 'setTax':
      return same(action.rate, g.taxes[action.tax]);
    case 'setTransfers':
      return same(action.perCapita, g.transfersPerCapita);
    case 'setSubsidy':
      return same(action.perUnit, g.announcedSubsidies[action.good] ?? 0);
    case 'setPriceCeiling': {
      const now = g.priceCeilings[action.good];
      return action.price === null ? now === undefined : now !== undefined && same(action.price, now);
    }
    default:
      return false;
  }
}

/** Основной экран (GDD 7): верхняя панель, карта, панели «Строить»/«Политика», ход и сводка месяца. */
export function GameScreen({ onBack }: { onBack: () => void }) {
  const data = getGameData();
  const scenario = useMemo(() => loadScenario(scenarioRaw, data), [data]);
  const [session, setSession] = useState<Session>(() => createSession(data, scenario, SEED));
  const [tab, setTab] = useState<Tab>('policy');
  /** На телефоне панель свёрнута, чтобы карте хватало места; на компьютере она открыта всегда (CSS). */
  const [panelOpen, setPanelOpen] = useState(false);
  const [chartsView, setChartsView] = useState<'xray' | 'indicators'>('xray');
  const [xrayTarget, setXrayTarget] = useState<{ good: string; province: string | undefined }>({ good: 'bread', province: undefined });
  const [chartMetric, setChartMetric] = useState<ChartMetric>('cpi');
  const states = useMemo(() => session.history.map((h) => h.state), [session.history]);
  const openXray = (good: string) => {
    setXrayTarget((x) => ({ ...x, good }));
    setChartsView('xray');
    setTab('charts');
    setPanelOpen(true);
    setDialog(null);
  };
  const [dialog, setDialog] = useState<Dialog>(null);

  const state = currentState(session);
  const prev = previousState(session);
  const consumerGoods = Object.keys(data.balance.demand.goods);

  const decide = (action: Action) => {
    setSession((s) => {
      const key = decisionKey(action);
      if (key !== undefined && isNoop(action, currentState(s))) {
        return { ...s, decisions: s.decisions.filter((d) => decisionKey(d) !== key) };
      }
      return addDecision(s, action);
    });
  };

  const advance = (turns: number) => {
    const next = turns === 1 ? endTurn(session, data) : fastForward(session, data, turns);
    const last = next.history.at(-1)!;
    const before = next.history.at(-2)!.state;
    setSession(next);
    setDialog({ kind: 'summary', turn: last.state.turn, items: monthSummary(before, last.state, last.causes, contextFromState(last.state), consumerGoods) });
  };

  const whyDialog = (metric: TopMetric) => {
    if (metric === 'trust') return <p>{t('why.trust')}</p>;
    const event = session.history.at(-1)!.causes.find((c) => c.metric === metric);
    const lines = event ? why(event, contextFromState(state)) : [];
    if (lines.length === 0 || !event || Math.abs(event.delta) < 1e-9) return <p>{t('why.none')}</p>;
    return (
      <ul class="why">
        {lines.map((l) => (
          <li key={l.ref} class={`why__line why__line--${l.direction}`}>
            {formatWhyLine(l)}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div class="game">
      <header class="game__header">
        <button type="button" class="chip" onClick={onBack}>
          {t('game.back')}
        </button>
        <span class="game__turn">{t('game.turn', { turn: state.turn })}</span>
      </header>
      <TopBar state={state} prev={prev} onWhy={(metric) => setDialog({ kind: 'why', metric })} />
      <main class="game__map">
        <MapView layout={scenario.map} buildings={data.buildings} state={state} prev={prev} />
        <details class="legend">
          <summary>{t('legend.title')}</summary>
          <ul>
            <li>{t('legend.deficit')}</li>
            <li>{t('legend.trend')}</li>
            <li>{t('legend.bottleneck')}</li>
            <li>{t('legend.shapes')}</li>
            <li>{t('legend.roads')}</li>
          </ul>
        </details>
      </main>
      <aside class="game__side">
        <div class="tabs" role="tablist">
          {(['policy', 'build', 'charts'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-expanded={panelOpen && tab === id}
              class={tab === id ? 'tab tab--active' : 'tab'}
              onClick={() => {
                setPanelOpen(!(panelOpen && tab === id));
                setTab(id);
              }}
            >
              {t(`tabs.${id}`)}
            </button>
          ))}
        </div>
        <div class={panelOpen ? 'game__panel game__panel--open' : 'game__panel'}>
          {tab === 'policy' && <PolicyPanel state={state} data={data} decisions={session.decisions} onDecide={decide} />}
          {tab === 'build' && <BuildPanel state={state} data={data} onDecide={decide} />}
          {tab === 'charts' && (
            <div class="panel">
              <div class="segmented" role="group">
                {(['xray', 'indicators'] as const).map((v) => (
                  <button key={v} type="button" class={chartsView === v ? 'chip chip--active' : 'chip'} aria-pressed={chartsView === v} onClick={() => setChartsView(v)}>
                    {t(v === 'xray' ? 'charts.xray' : 'charts.indicators')}
                  </button>
                ))}
              </div>
              {chartsView === 'xray' ? (
                <XrayView
                  state={state}
                  prev={prev}
                  causes={session.history.at(-1)!.causes}
                  data={data}
                  good={xrayTarget.good}
                  province={xrayTarget.province}
                  onSelect={(good, province) => setXrayTarget({ good, province })}
                />
              ) : (
                <ChartsPanel states={states} metric={chartMetric} onMetric={setChartMetric} />
              )}
            </div>
          )}
          <DecisionsPanel state={state} data={data} decisions={session.decisions} onRemove={(i) => setSession((s) => removeDecision(s, i))} />
        </div>
        {!panelOpen && session.decisions.length > 0 && (
          <p class="game__decisions-count">{t('decisions.count', { count: session.decisions.length })}</p>
        )}
        <div class="turnbar">
          <button type="button" class="turnbar__secondary" onClick={() => advance(FAST_FORWARD_TURNS)}>
            {t('game.skip3')}
          </button>
          <button type="button" class="turnbar__primary" onClick={() => advance(1)}>
            {t('game.next')}
          </button>
        </div>
      </aside>

      {dialog?.kind === 'summary' && (
        <Modal title={t('summary.title', { turn: dialog.turn })} onClose={() => setDialog(null)}>
          {dialog.items.every((i) => i.importance < 1) && <p class="section__hint">{t('summary.calm')}</p>}
          <ol class="summary">
            {dialog.items.map((item, i) => (
              <li key={i} class="summary__item">
                <strong>{describeSummary(item, state)}</strong>
                {item.kind === 'price' && item.target && (
                  <button type="button" class="chip summary__xray" onClick={() => openXray(item.target!)}>
                    {t('xray.open')}
                  </button>
                )}
                {item.causes.length > 0 && (
                  <ul class="why">
                    {item.causes.map((c) => (
                      <li key={c.ref} class={`why__line why__line--${c.direction}`}>
                        {formatWhyLine(c)}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          <button type="button" class="turnbar__primary modal__ok" onClick={() => setDialog(null)}>
            {t('summary.ok')}
          </button>
        </Modal>
      )}
      {dialog?.kind === 'why' && (
        <Modal
          title={t('why.title', { metric: dialog.metric === 'trust' ? t('top.trust') : metricLabel(dialog.metric, contextFromState(state)) })}
          onClose={() => setDialog(null)}
        >
          {whyDialog(dialog.metric)}
          {TOP_CHART[dialog.metric] && states.length >= 2 && (
            <ChartsPanel states={states} metric={TOP_CHART[dialog.metric]!} onMetric={() => undefined} compact />
          )}
        </Modal>
      )}
    </div>
  );
}
