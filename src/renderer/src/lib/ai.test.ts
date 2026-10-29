import { describe, expect, it } from 'vitest';
import type { AiBlock, AiHint, AiItemDTO } from '../../../shared/api';
import { en, pt } from '../i18n/strings';
import { aiStateOf, heatOf, isInUse, isSurelyCold, lossesOf, stateTipOf, waysOut } from './ai';

const DAY = 24 * 60 * 60 * 1000;

function item(fields: Partial<AiItemDTO> = {}): AiItemDTO {
  return {
    id: fields.path ?? '/Users/ana/.codex/sessions',
    tool: 'codex',
    kind: 'sessions',
    label: 'loja-online',
    project: null,
    path: '/Users/ana/.codex/sessions',
    size: 1000,
    count: 1,
    lastUsed: Date.now() - 60 * DAY,
    confidence: 'high',
    heat: 'cold',
    safety: 'moderate',
    removal: 'trash',
    ...fields,
  };
}

// O compilador obriga a lista a ter todos os bloqueios e hints do contrato, e nenhum a mais.
const BLOCKS: Record<AiBlock, true> = {
  'in-use': true,
  'app-open': true,
  'live-session': true,
  uncommitted: true,
  detached: true,
  'env-only': true,
  locked: true,
  submodule: true,
  'ignored-work': true,
  current: true,
  'self-cleaning': true,
  'via-app': true,
  tracked: true,
  unverified: true,
  recent: true,
  'app-closed': true,
};
const HINTS: Record<AiHint, true> = {
  'cleanup-period': true,
  'chrome-ai': true,
  'cowork-vm': true,
  'saved-chat': true,
  'tmp-cleaner': true,
  'branch-kept': true,
  redownload: true,
  'tool-command': true,
  'archive-first': true,
  reindex: true,
  'never-loaded': true,
  'generated-images': true,
};

describe('AI screen texts', () => {
  it('has text for every block and hint in both languages', () => {
    const keys = [
      ...Object.keys(BLOCKS).map((block) => `ai.block.${block}`),
      ...Object.keys(HINTS).map((hint) => `ai.hint.${hint}`),
    ];
    for (const key of keys) {
      expect(pt[key as keyof typeof pt], key).toBeTruthy();
      expect(en[key as keyof typeof en], key).toBeTruthy();
    }
    expect(pt['ai.block.submodule']).toBe('Tem submódulo: o git só tira à força, e o repositório dele iria junto');
  });

  it('counts scan steps, not tools', () => {
    // São 49 coletores para 43 ferramentas: "Lendo 12/49 ferramentas" prometia ferramentas que a tela não tem.
    for (const table of [pt, en]) {
      expect(table['ai.loading']).not.toMatch(/ferramentas|tools/);
      expect(table['ai.subtitle.loading']).not.toMatch(/ferramentas|tools/);
    }
  });

  it('no longer promises that everything goes to the Trash', () => {
    expect(pt['ai.trashNote']).not.toMatch(/^Tudo/);
    expect(en['ai.trashNote']).not.toMatch(/^Everything/);
    expect(pt['ai.dialog.command']).toMatch(/de vez/);
  });
});

describe('isInUse and heatOf', () => {
  it('treats an open app as a lock, not as use: the date decides the badge', () => {
    // Codex aberto agora: a conversa de dois meses atrás é fria no selo, no filtro e na barra.
    const old = item({ blocked: 'app-open', heat: 'cold' });
    expect(isInUse(old)).toBe(false);
    expect(aiStateOf(old)).toBe('cold');
    expect(heatOf(old)).toBe('cold');
  });

  it('shows the current version as in use and hot, never as cold', () => {
    const current = item({ kind: 'versions', blocked: 'current', removal: 'none', heat: 'cold', confidence: 'low' });
    expect(aiStateOf(current)).toBe('in-use');
    expect(heatOf(current)).toBe('hot');
    expect(stateTipOf(current)).toBe('ai.state.current.tip');
  });

  it('keeps a live session in use and hot whatever the scan said', () => {
    const live = item({ blocked: 'live-session', heat: 'cold' });
    expect(aiStateOf(live)).toBe('in-use');
    expect(heatOf(live)).toBe('hot');
  });
});

describe('stateTipOf', () => {
  it('does not claim "unused" when the only date is the download', () => {
    expect(stateTipOf(item({ kind: 'model', confidence: 'low' }))).toBe('ai.state.cold.low.tip');
    expect(stateTipOf(item({ kind: 'model', confidence: 'low', hint: 'never-loaded' }))).toBe('ai.state.cold.tip');
    expect(stateTipOf(item())).toBe('ai.state.cold.tip');
  });
});

describe('isSurelyCold', () => {
  it('takes cold items with a real date of use', () => {
    expect(isSurelyCold(item())).toBe(true);
  });

  it('leaves out a model whose only date is the download', () => {
    // whisper-large-v3 baixado há 120 dias e lido todo dia pelo MLX, que não mexe no mtime.
    const hf = item({ tool: 'hugging-face', kind: 'model', confidence: 'low', hint: 'redownload' });
    expect(isSurelyCold(hf)).toBe(false);
  });

  it('still takes junk and models never loaded, whatever the confidence', () => {
    expect(isSurelyCold(item({ kind: 'runtime', confidence: 'low', junk: 'old-version' }))).toBe(true);
    expect(isSurelyCold(item({ kind: 'model', confidence: 'low', hint: 'never-loaded' }))).toBe(true);
  });

  it('leaves out conversations that carry generated images', () => {
    expect(isSurelyCold(item({ hint: 'generated-images' }))).toBe(false);
  });

  it('never takes what is hot or blocked', () => {
    expect(isSurelyCold(item({ heat: 'hot' }))).toBe(false);
    expect(isSurelyCold(item({ blocked: 'app-open' }))).toBe(false);
    expect(isSurelyCold(item({ removal: 'none' }))).toBe(false);
  });
});

describe('waysOut', () => {
  it('tells the Ollama command apart from the Trash', () => {
    const ollama = item({ tool: 'ollama', kind: 'model', removal: 'command' });
    expect(waysOut([ollama])).toEqual({ trash: false, git: false, command: true });
    expect(waysOut([ollama, item()])).toEqual({ trash: true, git: false, command: true });
  });

  it('counts a worktree as going to the Trash too', () => {
    expect(waysOut([item({ kind: 'worktree', removal: 'git' })])).toEqual({ trash: true, git: true, command: false });
  });
});

describe('lossesOf', () => {
  it('warns first that generated images go along with the sessions', () => {
    // O aviso rola: as imagens, que podem ser a única cópia, não ficam no fim da lista.
    const losses = lossesOf([item({ kind: 'worktree', removal: 'git' }), item({ id: 'b', hint: 'generated-images' })]);
    expect(losses).toEqual([{ hint: 'generated-images', tools: ['codex'] }, { kind: 'sessions' }, { kind: 'worktree' }]);
  });

  it('repeats the hints that change what is lost, once per hint', () => {
    const losses = lossesOf([
      item({ hint: 'archive-first' }),
      item({ id: 'b', hint: 'archive-first' }),
      item({ id: 'c', tool: 'copilot', hint: 'reindex' }),
      item({ id: 'd', kind: 'cache', safety: 'safe', hint: 'redownload' }),
    ]);
    expect(losses).toEqual([{ kind: 'sessions' }, { hint: 'archive-first', tools: ['codex'] }, { hint: 'reindex', tools: ['copilot'] }]);
  });
});
