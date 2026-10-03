import { useEffect, useState } from 'preact/hooks';
import { codeFromHash, decodeScenarioCode, isCodeError, type ScenarioCode } from '../game/scenarioCode';
import { EnterCode, TeacherCode } from './CodeScreens';
import { getGameData, getLevels, getScenarios, type Level } from '../data';
import { newSession, parseProgress, parseSave, restore, type GameMode, type SavedGame } from '../game/save';
import type { Session } from '../game/session';
import { readStored, writeStored } from '../game/storage';
import { t, translate } from '../i18n';
import { GameScreen } from './GameScreen';
import { Briefing, levelTitle, Stars } from './LevelViews';

type Screen =
  | { kind: 'menu' }
  | { kind: 'briefing'; level: Level; seed: number }
  | { kind: 'sandbox' }
  | { kind: 'teacher' }
  | { kind: 'enterCode'; initial: string }
  | { kind: 'game'; mode: GameMode; session: Session; run: number };

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

/** Песочница без кода сценария играет с этим seed. */
const SANDBOX_SEED = 42;

/** Экран по коду сценария: уровень — через брифинг, песочница — сразу в игру. */
function screenForCode(code: ScenarioCode, start: (mode: GameMode, seed: number) => Screen): Screen {
  if (code.mode.kind === 'sandbox') return start(code.mode, code.seed);
  const levelId = code.mode.level;
  const level = getLevels().find((l) => l.id === levelId)!;
  return { kind: 'briefing', level, seed: code.seed };
}

/** Открытие по ссылке из QR (#code=…): код убирается из адреса, чтобы перезагрузка не начинала заново. */
function initialScreen(start: (mode: GameMode, seed: number) => Screen): Screen {
  const raw = codeFromHash(globalThis.location?.hash ?? '');
  if (raw === undefined) return { kind: 'menu' };
  try {
    globalThis.history?.replaceState(null, '', globalThis.location.pathname + globalThis.location.search);
  } catch {
    // Адрес не меняется — не страшно.
  }
  const code = decodeScenarioCode(raw, getLevels());
  return isCodeError(code) ? { kind: 'enterCode', initial: raw } : screenForCode(code, start);
}

export function App() {
  const data = getGameData();
  const gameScreen = (mode: GameMode, seed: number): Screen => ({
    kind: 'game',
    mode,
    session: newSession(data, mode, seed, getLevels(), getScenarios()),
    run: 0,
  });
  const [screen, setScreen] = useState<Screen>(() => initialScreen(gameScreen));
  // Ссылку с кодом открыли во вкладке, где игра уже идёт: меняется только #code=…
  useEffect(() => {
    const onHash = () => {
      if (codeFromHash(globalThis.location.hash) !== undefined) setScreen(initialScreen(gameScreen));
    };
    globalThis.addEventListener('hashchange', onHash);
    return () => globalThis.removeEventListener('hashchange', onHash);
  }, []);
  const menu = () => setScreen({ kind: 'menu' });
  const start = (mode: GameMode, seed: number) => setScreen(gameScreen(mode, seed));

  if (screen.kind === 'teacher') return <TeacherCode onBack={menu} />;
  if (screen.kind === 'enterCode') {
    return <EnterCode initial={screen.initial} onBack={menu} onOpen={(code) => setScreen(screenForCode(code, gameScreen))} />;
  }

  if (screen.kind === 'briefing') {
    const { level, seed } = screen;
    return <Briefing level={level} onBack={menu} onStart={() => start({ kind: 'level', level: level.id }, seed)} />;
  }
  if (screen.kind === 'sandbox') {
    return <SandboxSetup onBack={menu} onStart={(scenario) => start({ kind: 'sandbox', scenario }, SANDBOX_SEED)} />;
  }
  if (screen.kind === 'game') {
    const { mode, session, run } = screen;
    return (
      <GameScreen
        key={run}
        mode={mode}
        initial={session}
        onBack={menu}
        onReplay={() => setScreen({ kind: 'game', mode, session: newSession(data, mode, session.seed, getLevels(), getScenarios()), run: run + 1 })}
      />
    );
  }

  const saved = parseSave(readStored('save'));
  const progress = parseProgress(readStored('progress'));
  const savedTitle = (save: SavedGame) => {
    const level = save.mode.kind === 'level' ? getLevels().find((l) => l.id === (save.mode as { level: string }).level) : undefined;
    return level ? levelTitle(level) : t('menu.sandboxNamed', { scenario: translate(`scenario.${(save.mode as { scenario: string }).scenario}`) });
  };
  const resume = (save: SavedGame) => {
    try {
      setScreen({ kind: 'game', mode: save.mode, session: restore(save, data, getLevels(), getScenarios()), run: 0 });
    } catch {
      // Сохранение от старой версии (уровня или сценария больше нет) — просто забываем его.
      writeStored('save', null);
      menu();
    }
  };

  return (
    <main class="menu">
      <h1 class="menu__title">{t('app.title')}</h1>
      <p class="menu__subtitle">{t('app.subtitle')}</p>
      {saved && (
        <button type="button" class="menu__button menu__continue" onClick={() => resume(saved)}>
          {t('menu.continue')}
          <small>{t('menu.continueInfo', { title: savedTitle(saved), turn: saved.turns.length })}</small>
        </button>
      )}
      <h2 class="menu__section">{t('menu.campaign')}</h2>
      <ul class="menu__levels">
        {getLevels().map((level) => (
          <li key={level.id}>
            <button type="button" class="menu__button" onClick={() => setScreen({ kind: 'briefing', level, seed: level.seed })}>
              {levelTitle(level)}
              <small>
                {t('menu.levelInfo', { turns: level.turns })}
                {progress.stars[level.id] !== undefined && (
                  <>
                    {' · '}
                    <Stars stars={progress.stars[level.id]!} />
                  </>
                )}
              </small>
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
      <div class="menu__codes">
        <button type="button" class="chip" onClick={() => setScreen({ kind: 'enterCode', initial: '' })}>
          {t('code.enterButton')}
        </button>
        <button type="button" class="chip" onClick={() => setScreen({ kind: 'teacher' })}>
          {t('code.teacherButton')}
        </button>
      </div>
      <footer class="menu__footer">{t('app.version', { version: __APP_VERSION__ })}</footer>
    </main>
  );
}
