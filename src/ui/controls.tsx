import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { t } from '../i18n';

interface StepperProps {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  format: (v: number) => string;
  /** Текущее значение в мире (до решения) — показываем рядом, если игрок его меняет. */
  current?: number;
  onChange: (v: number) => void;
}

/** Число с кнопками − / +: удобно пальцем на телефоне. */
export function Stepper({ label, value, step, min, max, format, current, onChange }: StepperProps) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v / step) * step)));
  const changed = current !== undefined && Math.abs(current - value) > step / 1000;
  return (
    <div class="stepper">
      <span class="stepper__label">{label}</span>
      <div class="stepper__row">
        <button type="button" class="stepper__btn" aria-label={`${label}: −`} disabled={value <= min} onClick={() => set(value - step)}>
          −
        </button>
        <output class={changed ? 'stepper__value stepper__value--changed' : 'stepper__value'}>{format(value)}</output>
        <button type="button" class="stepper__btn" aria-label={`${label}: +`} disabled={value >= max} onClick={() => set(value + step)}>
          +
        </button>
      </div>
      {changed && <span class="stepper__current">{t('policy.current', { value: format(current) })}</span>}
    </div>
  );
}

export function Section({ title, hint, children }: { title: string; hint?: string; children: ComponentChildren }) {
  return (
    <section class="section">
      <h3 class="section__title">{title}</h3>
      {hint && <p class="section__hint">{hint}</p>}
      {children}
    </section>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="modal" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div class="modal__card" onClick={(e) => e.stopPropagation()}>
        <div class="modal__head">
          <h2 class="modal__title">{title}</h2>
          <button type="button" class="modal__close" aria-label={t('game.close')} onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
