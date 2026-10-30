import { describe, expect, it } from 'vitest';
import { RELEASE_NOTES, releaseNotes } from './releases';

describe('releaseNotes', () => {
  it('finds the notes of a release and of the beta that comes before it', () => {
    expect(releaseNotes('0.1.4', 'pt-BR')?.[0].title).toBe('Sessões de IA');
    expect(releaseNotes('0.1.4-beta.1', 'en')?.[0].title).toBe('AI sessions');
  });

  it('has nothing for a version without notes', () => {
    expect(releaseNotes('0.1.3', 'pt-BR')).toBeNull();
    expect(releaseNotes('', 'en')).toBeNull();
  });

  it('says the same number of things in both languages', () => {
    for (const notes of Object.values(RELEASE_NOTES)) {
      expect(notes.en).toHaveLength(notes['pt-BR'].length);
      for (const note of [...notes.en, ...notes['pt-BR']]) {
        expect(note.title).not.toBe('');
        expect(note.text).not.toBe('');
      }
    }
  });
});
