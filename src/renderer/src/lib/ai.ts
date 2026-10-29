import { Bot, BrainCircuit, SquareCode, Workflow, type LucideIcon } from 'lucide-react';
import {
  AI_TOOLS,
  type AiBlock,
  type AiFamily,
  type AiHint,
  type AiItemDTO,
  type AiKind,
  type AiToolId,
} from '../../../shared/api';
import type { StringKey } from '../i18n/strings';

/** Ordem fixa das seções na visão por ferramenta. */
export const AI_FAMILIES: AiFamily[] = ['assistant', 'editor', 'model', 'automation'];

export const AI_FAMILY_ICONS: Record<AiFamily, LucideIcon> = {
  assistant: Bot,
  editor: SquareCode,
  model: BrainCircuit,
  automation: Workflow,
};

/** Ordem em que o diálogo lista o que se perde. */
export const AI_KINDS: AiKind[] = [
  'sessions',
  'worktree',
  'checkpoints',
  'jobs',
  'scratch',
  'model',
  'runtime',
  'packages',
  'vm',
  'leftovers',
  'versions',
  'index',
  'cache',
  'logs',
  'temp',
];

/**
 * Bloqueios de quem está usando agora: contam como "em uso" no selo, no filtro e na barra.
 * O app aberto fica de fora: aberto está o app, não a conversa de três meses atrás, então a
 * idade decide o selo e a linha do cadeado explica. A versão atual entra: é a que a ferramenta roda.
 */
const LIVE_BLOCKS: ReadonlySet<AiBlock> = new Set(['in-use', 'live-session', 'current']);

export const isInUse = (item: AiItemDTO): boolean => !!item.blocked && LIVE_BLOCKS.has(item.blocked);

/** O calor que a tela mostra: o mesmo no selo, no filtro, no grupo e na barra. Em uso é quente. */
export const heatOf = (item: AiItemDTO): 'hot' | 'cold' => (isInUse(item) ? 'hot' : item.heat);

/** Só o que o processo principal aceita tirar: o resto aparece, mas não se marca. */
export const isRemovable = (item: AiItemDTO): boolean => item.removal !== 'none' && !item.blocked;

/** A data é de uso de verdade, e não só a do download ou da instalação. */
const knownUse = (item: AiItemDTO): boolean => item.confidence === 'high' || item.hint === 'never-loaded';

/**
 * O que "Marcar o que está frio" pega: só o que se sabe parado. Fica para marcar à mão o modelo
 * cuja única data é a do download (o MLX lê por mmap e não deixa rastro), e a conversa que leva
 * junto imagens geradas, que podem ser a única cópia.
 */
export function isSurelyCold(item: AiItemDTO): boolean {
  if (item.heat !== 'cold' || !isRemovable(item)) return false;
  if (item.hint === 'generated-images') return false;
  return !!item.junk || knownUse(item);
}

export type AiState = 'in-use' | 'orphan' | 'old-version' | 'cold' | 'hot';

/** O selo de cada item: em uso vence lixo, e lixo vence a idade. */
export function aiStateOf(item: AiItemDTO): AiState {
  if (isInUse(item)) return 'in-use';
  return item.junk ?? item.heat;
}

/** A dica do selo não afirma o que a data não prova. */
export function stateTipOf(item: AiItemDTO): StringKey {
  const state = aiStateOf(item);
  if (state === 'in-use' && item.blocked === 'current') return 'ai.state.current.tip';
  if (state === 'cold' && !knownUse(item)) return 'ai.state.cold.low.tip';
  return `ai.state.${state}.tip`;
}

/** Como a seleção sai: só se promete a Lixeira e a volta ao que vai para ela. */
export interface WaysOut {
  /** Vai para a Lixeira (a worktree também, antes do prune). */
  trash: boolean;
  git: boolean;
  /** Sai pelo comando da ferramenta (ollama rm), que apaga de vez. */
  command: boolean;
}

export function waysOut(items: readonly AiItemDTO[]): WaysOut {
  return {
    trash: items.some((item) => item.removal === 'trash' || item.removal === 'git'),
    git: items.some((item) => item.removal === 'git'),
    command: items.some((item) => item.removal === 'command'),
  };
}

/** Hints que mudam o que se perde: o diálogo as repete, porque a linha pode nunca ter sido aberta. */
export const LOSS_HINTS = ['generated-images', 'archive-first', 'reindex'] as const satisfies readonly AiHint[];
export type LossHint = (typeof LOSS_HINTS)[number];

export type AiLoss = { kind: AiKind } | { hint: LossHint; tools: AiToolId[] };

/**
 * O que se perde com o plano: por tipo, e pelas hints que o tipo não conta. As imagens geradas vêm
 * primeiro, porque podem ser a única cópia e o aviso rola: no fim da lista, ninguém as veria.
 */
export function lossesOf(plan: readonly AiItemDTO[]): AiLoss[] {
  const byHint = (hints: readonly LossHint[]) =>
    hints
      .map((hint) => ({ hint, tools: [...new Set(plan.filter((item) => item.hint === hint).map((item) => item.tool))] }))
      .filter((entry) => entry.tools.length > 0);
  const kinds = AI_KINDS.filter((kind) => plan.some((item) => item.kind === kind && item.safety === 'moderate'));
  return [
    ...byHint(['generated-images']),
    ...kinds.map((kind) => ({ kind })),
    ...byHint(LOSS_HINTS.filter((hint) => hint !== 'generated-images')),
  ];
}

/** Um coletor novo pode trazer uma ferramenta que esta versão da tela não conhece. */
export function aiTool(tool: string): { name: string; family: AiFamily } {
  return (AI_TOOLS as Record<string, { name: string; family: AiFamily }>)[tool] ?? { name: tool, family: 'assistant' };
}

/** O nome da pasta, que é como o projeto aparece na lista. */
export function projectName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

export const sumSize = (items: readonly AiItemDTO[]): number => items.reduce((sum, item) => sum + item.size, 0);
