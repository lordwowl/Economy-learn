import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Жёсткие правила 1–2 из CLAUDE.md: симуляция — чистая функция без UI и без недетерминизма.
const SIM_DIR = join(import.meta.dirname, '..', 'src', 'sim');

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('архитектура src/sim', () => {
  const files = listSourceFiles(SIM_DIR);

  it.each(files)('%s не импортирует ui/render/game', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/from\s+['"][^'"]*\/(ui|render|game)(\/|['"])/);
  });

  it.each(files)('%s не использует Math.random и Date.now', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(source).not.toMatch(/Math\.random|Date\.now/);
  });

  it('проверка запускается (пустой src/sim допустим до M3)', () => {
    expect(Array.isArray(files)).toBe(true);
  });
});
