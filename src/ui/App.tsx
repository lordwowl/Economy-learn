import { useState } from 'preact/hooks';
import { t } from '../i18n';

export function App() {
  const [started, setStarted] = useState(false);

  return (
    <main class="menu">
      <h1 class="menu__title">{t('app.title')}</h1>
      <p class="menu__subtitle">{t('app.subtitle')}</p>
      {started ? (
        <p class="menu__note" role="status">
          {t('menu.comingSoon')}
        </p>
      ) : (
        <button type="button" class="menu__button" onClick={() => setStarted(true)}>
          {t('menu.play')}
        </button>
      )}
      <footer class="menu__footer">{t('app.version', { version: __APP_VERSION__ })}</footer>
    </main>
  );
}
