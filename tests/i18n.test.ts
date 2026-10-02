import { describe, expect, it } from 'vitest';
import ru from '../src/i18n/ru.json';
import { t } from '../src/i18n';

describe('i18n', () => {
  it('возвращает строку по ключу', () => {
    expect(t('app.title')).toBe('Цепочка');
  });

  it('подставляет параметры', () => {
    expect(t('app.version', { version: '1.2.3' })).toBe('Версия 1.2.3');
  });

  it('оставляет неизвестный плейсхолдер как есть', () => {
    expect(t('app.version', {})).toBe('Версия {version}');
  });

  it('не содержит пустых строк', () => {
    for (const [key, value] of Object.entries(ru)) {
      expect(value.trim(), key).not.toBe('');
    }
  });
});
