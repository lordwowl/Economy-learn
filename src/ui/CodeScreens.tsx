// Код сценария в интерфейсе (GDD 8): учитель получает код, ссылку и QR; ученик вводит код или сканирует QR.

import { useEffect, useState } from 'preact/hooks';
import { getLevels } from '../data';
import type { GameMode } from '../game/save';
import { decodeScenarioCode, encodeScenarioCode, isCodeError, SANDBOX_SCENARIO_CODES, shareUrl, type ScenarioCode } from '../game/scenarioCode';
import { t, translate } from '../i18n';
import { levelTitle } from './LevelViews';

/** Песочница по коду играет с этим seed. Случайных событий в модели пока нет — seed в коде на будущее, выбирать его не нужно. */
const SANDBOX_SEED = 42;
const QR_QUIET_ZONE = 4;

/** QR из модулей библиотеки — обычный SVG без внешних ресурсов (библиотека — отдельный чанк). */
export function QrCode({ text, label }: { text: string; label: string }) {
  const [modules, setModules] = useState<boolean[][] | null>(null);
  useEffect(() => {
    let alive = true;
    void import('qrcode-generator').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      const grid = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
      if (alive) setModules(grid);
    });
    return () => {
      alive = false;
    };
  }, [text]);
  if (!modules) return <p class="section__hint">{t('code.qrLoading')}</p>;
  const size = modules.length + 2 * QR_QUIET_ZONE;
  let d = '';
  modules.forEach((row, r) => row.forEach((dark, c) => dark && (d += `M${c + QR_QUIET_ZONE} ${r + QR_QUIET_ZONE}h1v1h-1z`)));
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}

function modeKey(mode: GameMode): string {
  return mode.kind === 'level' ? `level:${mode.level}` : `sandbox:${mode.scenario}`;
}

/** Учителю: выбрать уровень или песочницу — получить код, ссылку и QR. */
export function TeacherCode({ onBack }: { onBack: () => void }) {
  const levels = getLevels();
  const modes: GameMode[] = [
    ...levels.map((l): GameMode => ({ kind: 'level', level: l.id })),
    ...SANDBOX_SCENARIO_CODES.map((scenario): GameMode => ({ kind: 'sandbox', scenario })),
  ];
  const [mode, setMode] = useState<GameMode>(modes[0]!);
  const seed = mode.kind === 'level' ? (levels.find((l) => l.id === mode.level)?.seed ?? SANDBOX_SEED) : SANDBOX_SEED;
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const code = encodeScenarioCode({ mode, seed }, levels);
  const url = shareUrl(code, globalThis.location?.href ?? '');
  const name = (m: GameMode) => {
    const level = m.kind === 'level' ? levels.find((l) => l.id === m.level) : undefined;
    return level ? levelTitle(level) : t('menu.sandboxNamed', { scenario: translate(`scenario.${(m as { scenario: string }).scenario}`) });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  return (
    <main class="briefing">
      <h1 class="briefing__title">{t('code.teacherTitle')}</h1>
      <p>{t('code.teacherHint')}</p>
      <fieldset class="choices">
        <legend class="section__title">{t('code.what')}</legend>
        {modes.map((m) => (
          <label key={modeKey(m)} class="choice">
            <input
              type="radio"
              name="mode"
              checked={modeKey(m) === modeKey(mode)}
              onChange={() => {
                setMode(m);
                setCopied(null);
              }}
            />
            <span>{name(m)}</span>
          </label>
        ))}
      </fieldset>
      <section class="code-card" aria-live="polite">
        <p class="section__hint">{t('code.forClass', { name: name(mode) })}</p>
        <p class="code-card__code">{code}</p>
        <QrCode text={url} label={t('code.qrLabel', { code })} />
        <p class="code-card__url">{url}</p>
        <button type="button" class="chip" onClick={() => void copy()}>
          {t('code.copy')}
        </button>
        {copied && <p class="section__hint">{t(copied === 'ok' ? 'code.copied' : 'code.copyFailed')}</p>}
      </section>
      <div class="briefing__actions">
        <button type="button" class="turnbar__secondary" onClick={onBack}>
          {t('report.menu')}
        </button>
      </div>
    </main>
  );
}

/** Ученику: ввести код со стола или доски. */
export function EnterCode({ onOpen, onBack, initial = '' }: { onOpen: (code: ScenarioCode) => void; onBack: () => void; initial?: string }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    const result = decodeScenarioCode(text, getLevels());
    if (isCodeError(result)) setError(t(`code.error.${result}`));
    else onOpen(result);
  };
  return (
    <main class="briefing">
      <h1 class="briefing__title">{t('code.enterTitle')}</h1>
      <p>{t('code.enterHint')}</p>
      <form
        class="field"
        onSubmit={(e) => {
          e.preventDefault();
          open();
        }}
      >
        <label class="section__title" for="scenario-code">
          {t('code.label')}
        </label>
        <input
          id="scenario-code"
          class="code-input"
          autoComplete="off"
          autoCapitalize="characters"
          spellcheck={false}
          placeholder="XXXX-XXXX-XXXX"
          value={text}
          aria-invalid={error !== null}
          aria-describedby={error ? 'scenario-code-error' : undefined}
          onInput={(e) => {
            setText((e.target as HTMLInputElement).value);
            setError(null);
          }}
        />
        {error && (
          <p id="scenario-code-error" class="field__error" role="alert">
            ⚠ {error}
          </p>
        )}
        <div class="briefing__actions">
          <button type="button" class="turnbar__secondary" onClick={onBack}>
            {t('report.menu')}
          </button>
          <button type="submit" class="turnbar__primary">
            {t('code.open')}
          </button>
        </div>
      </form>
    </main>
  );
}
