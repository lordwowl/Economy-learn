// Уровень в интерфейсе (GDD 7): брифинг, цели со звёздами, отчёт с причинной цепочкой.

import { useMemo } from 'preact/hooks';
import type { GameData, Level } from '../data';
import { contextFromState } from '../game/explain';
import type { GoalStatus } from '../game/level';
import { levelReport } from '../game/report';
import type { TurnRecord } from '../game/session';
import { t, translate } from '../i18n';
import { Section } from './controls';
import { describeChainLink, describeDecision, describeDefeat, describeGoal, describeGoalStatus } from './labels';

const STARS = [1, 2, 3] as const;

/** «★★☆»: форма звезды, а не цвет, + текст «Звёзды: 2 из 3». */
export function Stars({ stars }: { stars: number }) {
  return (
    <span class="stars" role="img" aria-label={t('stars.label', { stars })}>
      {'★'.repeat(stars)}
      <span class="stars__empty">{'☆'.repeat(3 - stars)}</span>
    </span>
  );
}

export function levelTitle(level: Level): string {
  return t('menu.level', { number: level.number, title: translate(level.titleKey) });
}

/** Цели по звёздам; со статусами — во время игры и в отчёте. */
export function GoalList({ level, statuses }: { level: Level; statuses?: readonly GoalStatus[] }) {
  return (
    <div class="goals">
      {STARS.map((star) => (
        <div class="goals__group" key={star}>
          <h4 class="goals__title">
            <Stars stars={star} /> {translate(`stars.group${star}`)}
          </h4>
          <ul class="goals__list">
            {level.goals
              .filter((g) => g.star === star)
              .map((goal) => {
                const status = statuses?.find((s) => s.id === goal.id);
                return (
                  <li key={goal.id} class={status ? `goal goal--${status.state}` : 'goal'}>
                    <span>{describeGoal(goal.condition)}</span>
                    {status && <small class="goal__status">{describeGoalStatus(status)}</small>}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function Briefing({ level, onStart, onBack }: { level: Level; onStart: () => void; onBack: () => void }) {
  return (
    <main class="briefing">
      <h1 class="briefing__title">{levelTitle(level)}</h1>
      <p>{translate(level.briefingKey)}</p>
      <p class="section__hint">{t('briefing.turns', { turns: level.turns })}</p>
      <Section title={t('briefing.goals')}>
        <GoalList level={level} />
      </Section>
      <div class="briefing__actions">
        <button type="button" class="turnbar__secondary" onClick={onBack}>
          {t('report.menu')}
        </button>
        <button type="button" class="turnbar__primary" onClick={onStart}>
          {t('briefing.start')}
        </button>
      </div>
    </main>
  );
}

interface ReportProps {
  level: Level;
  history: readonly TurnRecord[];
  data: GameData;
  onReplay: () => void;
  onMenu: () => void;
  onClose: () => void;
}

export function reportTitle(level: Level, history: readonly TurnRecord[], data: GameData): string {
  const { status } = levelReport(level, history, data.balance);
  if (status.outcome === 'defeated') return t('report.title.defeated');
  return status.stars > 0 ? t('report.title.completed') : t('report.title.zero');
}

/** Отчёт уровня (GDD 7, экран 8): звёзды, цели, «почему так вышло», решения, вопросы. */
export function LevelReport({ level, history, data, onReplay, onMenu, onClose }: ReportProps) {
  const report = useMemo(() => levelReport(level, history, data.balance), [level, history, data]);
  const start = history[0]!.state;
  const last = history.at(-1)!.state;
  const ctx = contextFromState(last);
  const { status } = report;
  return (
    <div class="report">
      <p class="report__stars">
        <Stars stars={status.stars} /> <span>{t('stars.label', { stars: status.stars })}</span>
      </p>
      {status.defeat && <p class="report__defeat">⚠ {describeDefeat(status.defeat, last, data.balance)}</p>}

      <Section title={t('report.goals')}>
        <GoalList level={level} statuses={status.goals} />
      </Section>

      <Section title={t('report.chain')} hint={t('report.chainHint')}>
        {report.chains.length === 0 && <p>{t('report.noChain')}</p>}
        {report.chains.map((chain, i) => (
          <ol class="chain" key={i}>
            {chain.decisions.map((d, j) => (
              <li key={`d${j}`} class="chain__link chain__link--decision">
                <strong>{t('report.yourDecision', { decision: describeDecision(d.action, last, data), turn: d.turn })}</strong>
              </li>
            ))}
            {[...chain.links].reverse().map((link) => {
              const text = describeChainLink(link, start, ctx);
              return (
                <li key={link.metric} class="chain__link">
                  <strong>{text.title}</strong>
                  <span>{text.cause}</span>
                </li>
              );
            })}
          </ol>
        ))}
      </Section>

      <Section title={t('report.decisions')}>
        {report.decisions.length === 0 ? (
          <p>{t('report.noDecisions')}</p>
        ) : (
          <ul class="report__list">
            {report.decisions.map((d, i) => (
              <li key={i}>{t('report.dated', { turn: d.turn, text: describeDecision(d.action, last, data) })}</li>
            ))}
          </ul>
        )}
      </Section>

      {report.events.length > 0 && (
        <Section title={t('report.events')}>
          <ul class="report__list">
            {report.events.map((d, i) => (
              <li key={i}>{t('report.dated', { turn: d.turn, text: describeDecision(d.action, last, data) })}</li>
            ))}
          </ul>
        </Section>
      )}

      {level.questions.length > 0 && (
        <Section title={t('report.questions')}>
          <ol class="report__list">
            {level.questions.map((q) => (
              <li key={q}>{translate(q)}</li>
            ))}
          </ol>
        </Section>
      )}

      <div class="report__actions">
        <button type="button" class="turnbar__primary" onClick={onReplay}>
          {t('report.replay')}
        </button>
        <button type="button" class="turnbar__secondary" onClick={onMenu}>
          {t('report.menu')}
        </button>
        <button type="button" class="chip" onClick={onClose}>
          {t('report.view')}
        </button>
      </div>
    </div>
  );
}
