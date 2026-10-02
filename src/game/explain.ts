// Объяснения причинного журнала (GDD 6): «Почему?» у любой цифры — 2–3 главные причины простым языком.
// Тексты — в ru.json, связь «метрика/причина → ключ» — в data/explanations.json.

import { getExplanations } from '../data';
import type { Explanations } from '../data/schemas';
import { translate } from '../i18n';
import type { Cause, CauseEvent } from '../sim/causes';
import type { WorldState } from '../sim/state';

/** Как превратить id из шаблона в название для текста. */
export interface ExplainContext {
  name(param: string, id: string): string;
}

/** Названия из состояния мира: товары, провинции, фирмы, отрасли. */
export function contextFromState(state: WorldState): ExplainContext {
  const provinces = new Map(state.provinces.map((p) => [p.id, translate(p.nameKey)]));
  const firms = new Map(state.firms.map((f) => [f.id, f]));
  return {
    name(param, id) {
      switch (param) {
        case 'good':
          return translate(`good.${id}`);
        case 'province':
          return provinces.get(id) ?? id;
        case 'shock':
          return translate(`shock.${id}`);
        case 'sector':
          return id === 'logistics' ? translate('sector.logistics') : translate(`building.${id}`);
        case 'firm': {
          const firm = firms.get(id);
          if (!firm) return id;
          return translate('explain.firm', { building: translate(`building.${firm.building}`), province: provinces.get(firm.province) ?? firm.province });
        }
        default:
          return id;
      }
    },
  };
}

type Group = Explanations['groups'][number];

interface Compiled {
  regex: RegExp;
  names: string[];
}

const cache = new Map<string, Compiled>();

function compile(pattern: string): Compiled {
  let compiled = cache.get(pattern);
  if (!compiled) {
    const names: string[] = [];
    const source = pattern
      .split(/(\{[a-zA-Z]+\})/)
      .map((part) => {
        const m = /^\{([a-zA-Z]+)\}$/.exec(part);
        if (m) {
          names.push(m[1]!);
          return '([^.]+)';
        }
        return part.replace(/\./g, '\\.');
      })
      .join('');
    compiled = { regex: new RegExp(`^${source}$`), names };
    cache.set(pattern, compiled);
  }
  return compiled;
}

/** Совпадение id с шаблоном: значения {имён} или undefined. */
export function matchPattern(pattern: string, id: string): Record<string, string> | undefined {
  const { regex, names } = compile(pattern);
  const m = regex.exec(id);
  if (!m) return undefined;
  return Object.fromEntries(names.map((n, i) => [n, m[i + 1]!]));
}

function render(key: string, params: Record<string, string>, ctx: ExplainContext): string {
  const named: Record<string, string> = {};
  for (const [param, id] of Object.entries(params)) named[param] = ctx.name(param, id);
  return translate(key, named);
}

/** Группа объяснений и название метрики. */
export function findMetric(metric: string, explanations: Explanations = getExplanations()) {
  for (const group of explanations.groups) {
    for (const m of group.metrics) {
      const params = matchPattern(m.pattern, metric);
      if (params) return { group, key: m.key, params };
    }
  }
  return undefined;
}

/** Шаблон причины внутри группы. */
export function findCause(group: Group, ref: string) {
  for (const c of group.causes) {
    const params = matchPattern(c.pattern, ref);
    if (params) return { entry: c, params };
  }
  return undefined;
}

export function metricLabel(metric: string, ctx: ExplainContext): string {
  const found = findMetric(metric);
  return found ? render(found.key, found.params, ctx) : metric;
}

export interface WhyLine {
  ref: string;
  /** ▲ — причина увеличила метрику, ▼ — уменьшила (цвет не единственный носитель смысла). */
  direction: 'up' | 'down';
  text: string;
  value: number;
  share: number;
}

export function causeLine(metric: string, cause: Cause, ctx: ExplainContext): WhyLine {
  const direction = cause.value >= 0 ? 'up' : 'down';
  const group = findMetric(metric)?.group;
  const found = group ? findCause(group, cause.ref) : undefined;
  const key = found ? (direction === 'down' ? (found.entry.down ?? found.entry.up) : found.entry.up) : undefined;
  return {
    ref: cause.ref,
    direction,
    text: key ? render(key, found!.params, ctx) : cause.ref,
    value: cause.value,
    share: cause.share,
  };
}

/** Кнопка «Почему?»: главные причины изменения метрики (по абсолютному вкладу). */
export function why(event: CauseEvent, ctx: ExplainContext, max = 3): WhyLine[] {
  return event.causes.slice(0, max).map((c) => causeLine(event.metric, c, ctx));
}

/** Строка для журнала: «▲ Подорожал вход «Мука» — 62%». */
export function formatWhyLine(line: WhyLine): string {
  const arrow = line.direction === 'up' ? '▲' : '▼';
  return `${arrow} ${line.text} — ${Math.round(Math.abs(line.share) * 100)}%`;
}
