import { describe, it, expect } from 'vitest';
import { parseDefaultsBool, parseSpotlightStatus } from './maintenance';

describe('maintenance', () => {
  it('reads whether Spotlight indexes the startup disk', () => {
    expect(parseSpotlightStatus('/:\n\tIndexing enabled. \n')).toBe(true);
    expect(parseSpotlightStatus('/:\n\tIndexing disabled.\n')).toBe(false);
    expect(parseSpotlightStatus('/:\n\tIndexing and searching disabled.\n')).toBe(false);
  });

  it('does not guess the Spotlight status from output it does not know', () => {
    expect(parseSpotlightStatus('')).toBeNull();
    expect(parseSpotlightStatus('/:\n\tError: unknown indexing state.\n')).toBeNull();
  });

  it('reads booleans written by defaults', () => {
    expect(parseDefaultsBool('1\n')).toBe(true);
    expect(parseDefaultsBool('0\n')).toBe(false);
    expect(parseDefaultsBool('')).toBe(false);
    expect(parseDefaultsBool('10\n')).toBe(false);
  });
});
