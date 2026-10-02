# PROGRESS

## Статус этапов v0.1
- [x] M1. Каркас: Vite + TS strict + Preact + Vitest + деплой на GitHub Pages через Actions
- [ ] M2. Данные: zod-схемы, `balance.json`, `goods.json`, `recipes.json`, `buildings.json`
- [ ] M3–M12 — см. CLAUDE.md

## Сделано
### 2026-10-02 — M1
- `GDD.md` перенесён в `docs/`.
- Каркас: Vite 8, TypeScript 7 (strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Preact 11, Vitest 5. Версии зафиксированы точно.
- `vite.config.ts`: `base: '/Economy-learn/'`, версия приложения из `package.json` через `define`.
- i18n: `src/i18n/ru.json` + типизированная функция `t(key, params)` — неизвестный ключ не скомпилируется.
- Стартовый экран-заглушка (mobile-first, светлая/тёмная тема, без внешних шрифтов). Проверен в Chromium на 360×640 и 1366×768: без горизонтального скролла и ошибок в консоли.
- Тесты: i18n; архитектурный тест `src/sim` (нет импортов из ui/render/game, нет `Math.random`/`Date.now`) — заработает в полную силу с M3.
- CI: `.github/workflows/deploy.yml` (push в `main`: `npm ci` → `npm test` → `npm run build` → Pages), `.github/workflows/ci.yml` (тесты и сборка на каждый PR в `main`).

## Зависимости (обоснование)
| Пакет | Зачем |
|---|---|
| preact | UI (стек из CLAUDE.md) |
| vite, @preact/preset-vite | сборка, JSX для Preact |
| typescript | strict-типизация |
| vitest | тесты |
| @types/node | типы `node:fs`/`node:path` для тестов и будущего `tools/sim-runner.ts` |

## Дальше
- M2: zod-схемы и JSON-данные (`balance.json`, `goods.json`, `recipes.json`, `buildings.json`).
- vite-plugin-pwa пока не подключён: по GDD офлайн-режим — v1.0, подключим, когда появится что кэшировать (не позднее M12).

## Известные проблемы
- Нет.

## Решения по балансу
- Пока нет.

## Вопросы к Андрею
1. Где лежит `ru.json`: GDD (раздел 11) — `data/i18n/ru.json`, CLAUDE.md — `src/i18n/ru.json`. Выбран вариант из CLAUDE.md (`src/i18n/ru.json`), так строки импортируются с проверкой типов.
