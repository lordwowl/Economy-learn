import ru from './ru.json';

export type I18nKey = keyof typeof ru;

const dict: Record<I18nKey, string> = ru;

/** Возвращает строку UI по ключу; `{name}` в шаблоне заменяется на params.name. */
export function t(key: I18nKey, params?: Record<string, string | number>): string {
  const template = dict[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
