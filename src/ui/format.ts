// Форматирование чисел для интерфейса (русская запись: запятая, неразрывные пробелы).

import { t } from '../i18n';

const nf = (digits: number) =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const cache = new Map<number, Intl.NumberFormat>();

export function num(value: number, digits = 0): string {
  let f = cache.get(digits);
  if (!f) {
    f = nf(digits);
    cache.set(digits, f);
  }
  return f.format(value);
}

/** Доля → «12,5%». */
export function pct(share: number, digits = 1): string {
  return `${num(share * 100, digits)}%`;
}

/** Со знаком: «+1,2» / «−0,4». */
export function signed(value: number, digits = 1): string {
  const s = num(Math.abs(value), digits);
  return value > 0 ? `+${s}` : value < 0 ? `−${s}` : s;
}

/** Стрелка направления, дублирующая цвет. */
export function arrow(value: number): string {
  return value > 0 ? '▲' : value < 0 ? '▼' : '•';
}

/** Деньги во вымышленной валюте (ru.json: currency.amount): «1 200 кол.». */
export function money(value: number, digits = 0): string {
  return t('currency.amount', { value: num(value, digits) });
}

/** Деньги со знаком: «+120 кол.» / «−31 кол.». */
export function signedMoney(value: number, digits = 0): string {
  return t('currency.amount', { value: signed(value, digits) });
}
