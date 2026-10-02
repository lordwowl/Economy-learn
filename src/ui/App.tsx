import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { MapScreen } from './MapScreen';

export function App() {
  const [screen, setScreen] = useState<'menu' | 'map'>('menu');

  if (screen === 'map') return <MapScreen onBack={() => setScreen('menu')} />;

  return (
    <main class="menu">
      <h1 class="menu__title">{t('app.title')}</h1>
      <p class="menu__subtitle">{t('app.subtitle')}</p>
      <button type="button" class="menu__button" onClick={() => setScreen('map')}>
        {t('menu.play')}
      </button>
      <footer class="menu__footer">{t('app.version', { version: __APP_VERSION__ })}</footer>
    </main>
  );
}
