// Код сценария (GDD 8, режим учителя): короткая строка и QR — весь класс открывает одно и то же без сервера.
// 7 байт → 12 символов Crockford base32 (без I, L, O, U — их не спутать с цифрами), вида «XXXX-XXXX-XXXX»:
//   байт 0 — версия (старшие 4 бита) и вид (0 — уровень, 1 — песочница); байт 1 — номер уровня или номер сценария
//   песочницы; байты 2–5 — seed (беззнаковый, big-endian); байт 6 — CRC-8 первых шести байтов.

import type { Level } from '../data';
import type { GameMode } from './save';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VERSION = 1;
const BYTES = 7;
const CHARS = Math.ceil((BYTES * 8) / 5);
const GROUP = 4;

/** Сценарии песочницы по номерам в коде. Список только дополняется: номер сценария — навсегда (старые коды должны открываться). */
export const SANDBOX_SCENARIO_CODES = ['baseline', 'chain', 'harvest', 'ceiling', 'overheating'] as const;

export interface ScenarioCode {
  mode: GameMode;
  seed: number;
}

export type CodeError = 'format' | 'checksum' | 'version' | 'unknown';

function crc8(bytes: readonly number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function toBase32(bytes: readonly number[]): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): number[] | undefined {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) return undefined;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  // Хвостовые биты дополнения должны быть нулями — иначе это опечатка.
  return value === 0 ? bytes : undefined;
}

/** Код сценария: «XXXX-XXXX-XXXX». */
export function encodeScenarioCode(code: ScenarioCode, levels: readonly Level[]): string {
  const sandbox = code.mode.kind === 'sandbox';
  const index =
    code.mode.kind === 'level'
      ? levels.find((l) => l.id === (code.mode as { level: string }).level)?.number
      : SANDBOX_SCENARIO_CODES.indexOf((code.mode as { scenario: string }).scenario as (typeof SANDBOX_SCENARIO_CODES)[number]);
  if (index === undefined || index < 0 || index > 255) throw new Error(`Нельзя закодировать ${JSON.stringify(code.mode)}`);
  const seed = code.seed >>> 0;
  const bytes = [(VERSION << 4) | (sandbox ? 1 : 0), index, (seed >>> 24) & 0xff, (seed >>> 16) & 0xff, (seed >>> 8) & 0xff, seed & 0xff];
  const text = toBase32([...bytes, crc8(bytes)]);
  return text.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-');
}

/** Ввод ученика: регистр, пробелы, дефисы и похожие буквы (O → 0, I/L → 1) не важны. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function decodeScenarioCode(input: string, levels: readonly Level[]): ScenarioCode | CodeError {
  const text = normalizeCode(input);
  if (text.length !== CHARS) return 'format';
  if ([...text].some((ch) => !ALPHABET.includes(ch))) return 'format';
  const bytes = fromBase32(text);
  // Длина и буквы верные, а биты дополнения не нули — это опечатка, как и несошедшаяся контрольная сумма.
  if (!bytes || bytes.length !== BYTES) return 'checksum';
  if (crc8(bytes.slice(0, BYTES - 1)) !== bytes[BYTES - 1]) return 'checksum';
  const [head, index, s0, s1, s2, s3] = bytes as [number, number, number, number, number, number];
  if (head >> 4 !== VERSION) return 'version';
  const seed = ((s0 << 24) | (s1 << 16) | (s2 << 8) | s3) >>> 0;
  if ((head & 0x0f) === 1) {
    const scenario = SANDBOX_SCENARIO_CODES[index];
    return scenario ? { mode: { kind: 'sandbox', scenario }, seed } : 'unknown';
  }
  if ((head & 0x0f) !== 0) return 'format';
  const level = levels.find((l) => l.number === index);
  return level ? { mode: { kind: 'level', level: level.id }, seed } : 'unknown';
}

export function isCodeError(value: ScenarioCode | CodeError): value is CodeError {
  return typeof value === 'string';
}

/** Ссылка для QR и рассылки: адрес игры + #code=… (сервер не нужен — код читает сама страница). */
export function shareUrl(code: string, pageUrl: string): string {
  return `${pageUrl.split('#')[0]}#code=${code}`;
}

/** Код из адреса страницы (#code=…), если он есть. */
export function codeFromHash(hash: string): string | undefined {
  return /(?:^#|&)code=([0-9A-Za-z-]+)/.exec(hash)?.[1];
}
