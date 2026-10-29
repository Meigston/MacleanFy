import { Bot, BrainCircuit, SquareCode, Workflow, type LucideIcon } from 'lucide-react';
import { AI_TOOLS, type AiBlock, type AiFamily, type AiItemDTO, type AiKind } from '../../../shared/api';

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

/** Bloqueios de quem está usando agora: contam como "em uso" no selo e na barra. */
const LIVE_BLOCKS: ReadonlySet<AiBlock> = new Set(['in-use', 'live-session', 'app-open']);

export const isInUse = (item: AiItemDTO): boolean => !!item.blocked && LIVE_BLOCKS.has(item.blocked);

/** Só o que o processo principal aceita tirar: o resto aparece, mas não se marca. */
export const isRemovable = (item: AiItemDTO): boolean => item.removal !== 'none' && !item.blocked;

export type AiState = 'in-use' | 'orphan' | 'old-version' | 'cold' | 'hot';

/** O selo de cada item: em uso vence lixo, e lixo vence a idade. */
export function aiStateOf(item: AiItemDTO): AiState {
  if (isInUse(item)) return 'in-use';
  return item.junk ?? item.heat;
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
