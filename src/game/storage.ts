// Хранилище браузера (CLAUDE.md, правило 6: только localStorage). Недоступно (приватный режим, запрет) — игра работает без сохранений.

const KEYS = { save: 'chain.save', progress: 'chain.progress' } as const;
export type StorageKey = keyof typeof KEYS;

export function readStored(key: StorageKey): string | null {
  try {
    return globalThis.localStorage?.getItem(KEYS[key]) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(key: StorageKey, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(KEYS[key]);
    else globalThis.localStorage?.setItem(KEYS[key], value);
  } catch {
    // Нет места или хранилище запрещено — продолжаем без сохранения.
  }
}
