import { useState } from 'preact/hooks';
import { getLevels, type Level } from '../data';
import { t } from '../i18n';
import { GameScreen } from './GameScreen';
import { Briefing, levelTitle } from './LevelViews';

type Screen = { kind: 'menu' } | { kind: 'briefing'; level: Level } | { kind: 'game'; level?: Level; run: number };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' });
  const menu = () => setScreen({ kind: 'menu' });

  if (screen.kind === 'briefing') {
    return <Briefing level={screen.level} onBack={menu} onStart={() => setScreen({ kind: 'game', level: screen.level, run: 0 })} />;
  }
  if (screen.kind === 'game') {
    const { level, run } = screen;
    return (
      <GameScreen
        key={run}
        {...(level ? { level } : {})}
        onBack={menu}
        onReplay={() => setScreen(level ? { kind: 'game', level, run: run + 1 } : { kind: 'game', run: run + 1 })}
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
          <button type="button" class="menu__button menu__button--secondary" onClick={() => setScreen({ kind: 'game', run: 0 })}>
            {t('menu.sandbox')}
            <small>{t('menu.sandboxHint')}</small>
          </button>
        </li>
      </ul>
      <footer class="menu__footer">{t('app.version', { version: __APP_VERSION__ })}</footer>
    </main>
  );
}
