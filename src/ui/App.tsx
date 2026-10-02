import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { GameScreen } from './GameScreen';

export function App() {
  const [screen, setScreen] = useState<'menu' | 'game'>('menu');

  if (screen === 'game') return <GameScreen onBack={() => setScreen('menu')} />;

  return (
    <main class="menu">
      <h1 class="menu__title">{t('app.title')}</h1>
      <p class="menu__subtitle">{t('app.subtitle')}</p>
      <button type="button" class="menu__button" onClick={() => setScreen('game')}>
        {t('menu.play')}
      </button>
      <footer class="menu__footer">{t('app.version', { version: __APP_VERSION__ })}</footer>
    </main>
  );
}
