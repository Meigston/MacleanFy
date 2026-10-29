import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// O tradutor só lê o idioma do store no hook; o store mexe em window ao carregar.
vi.mock('../state/store', () => ({ useStore: vi.fn() }));

import { createTranslator } from '.';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-29T12:00:00Z');

describe('ago', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a date in the future as now', () => {
    // Relógio adiantado ou arquivo de outro Mac: "último uso em 3 dias" não faz sentido.
    expect(createTranslator('pt-BR').ago(NOW + 3 * DAY)).toBe('agora');
    expect(createTranslator('en').ago(NOW + 3 * DAY)).toBe('now');
  });

  it('keeps days below a month', () => {
    expect(createTranslator('pt-BR').ago(NOW - DAY)).toBe('ontem');
    expect(createTranslator('pt-BR').ago(NOW - 29 * DAY)).toBe('há 29 dias');
  });

  it('moves to months and years for long ages', () => {
    const pt = createTranslator('pt-BR');
    expect(pt.ago(NOW - 30 * DAY)).toBe('há 1 mês');
    expect(pt.ago(NOW - 120 * DAY)).toBe('há 3 meses');
    expect(pt.ago(NOW - 900 * DAY)).toBe('há 2 anos');
    expect(createTranslator('en').ago(NOW - 40 * DAY)).toBe('1 month ago');
    expect(createTranslator('en').ago(NOW - 365 * DAY)).toBe('1 year ago');
  });
});
