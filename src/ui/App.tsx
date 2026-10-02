import { useState } from 'preact/hooks';
import { getLevels, getScenarios, type Level } from '../data';
import { t, translate } from '../i18n';
import { GameScreen } from './GameScreen';
import { Briefing, levelTitle } from './LevelViews';

type Screen = { kind: 'menu' } | { kind: 'briefing'; level: Level } | { kind: 'sandbox' } | { kind: 'game'; level?: Level; scenario?: string; run: number };

/** Облегчённая песочница (GDD 8): выбор стартовой экономики. */
function SandboxSetup({ onStart, onBack }: { onStart: (scenario: string) => void; onBack: () => void }) {
  const [scenario, setScenario] = useState('baseline');
  return (
    <main class="briefing">
      <h1 class="briefing__title">{t('sandbox.title')}</h1>
      <p>{t('menu.sandboxHint')}</p>
      <fieldset class="choices">
        <legend class="section__title">{t('sandbox.scenario')}</legend>
        {Object.keys(getScenarios()).map((id) => (
          <label key={id} class="choice">
            <input type="radio" name="scenario" value={id} checked={scenario === id} onChange={() => setScenario(id)} />
            <span>{translate(`scenario.${id}`)}</span>
          </label>
        ))}
      </fieldset>
      <div class="briefing__actions">
        <button type="button" class="turnbar__secondary" onClick={onBack}>
          {t('report.menu')}
        </button>
        <button type="button" class="turnbar__primary" onClick={() => onStart(scenario)}>
          {t('sandbox.start')}
        </button>
      </div>
    </main>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const menu = () => setScreen({ kind: 'menu' });

  if (screen.kind === 'briefing') {
    return <Briefing level={screen.level} onBack={menu} onStart={() => setScreen({ kind: 'game', level: screen.level, run: 0 })} />;
  }
  if (screen.kind === 'sandbox') {
    return <SandboxSetup onBack={menu} onStart={(scenario) => setScreen({ kind: 'game', scenario, run: 0 })} />;
  }
  if (screen.kind === 'game') {
    const { level, scenario, run } = screen;
    return (
      <GameScreen
        key={run}
        {...(level ? { level } : {})}
        {...(scenario ? { scenario } : {})}
        onBack={menu}
        onReplay={() => setScreen({ ...screen, run: run + 1 })}
      />
    );
  }

  return (
    <main class="menu">
      <h1 class="menu__title">{t('app.title')}</h1>
      <p class="menu__subtitle">{t('app.subtitle')}</p>
      <h2 class="menu__section">{t('menu.campaign')}</h2>
      <ul class="menu__levels">
        {getLevels().map((level) => (
          <li key={level.id}>
            <button type="button" class="menu__button" onClick={() => setScreen({ kind: 'briefing', level })}>
              {levelTitle(level)}
              <small>{t('menu.levelInfo', { turns: level.turns })}</small>
            </button>
          </li>
        ))}
        <li>
          <button type="button" class="menu__button menu__button--secondary" onClick={() => setScreen({ kind: 'sandbox' })}>
            {t('menu.sandbox')}
            <small>{t('menu.sandboxHint')}</small>
          </button>
        </li>
      </ul>
      <footer class="menu__footer">{t('app.version', { version: __APP_VERSION__ })}</footer>
    </main>
  );
}
