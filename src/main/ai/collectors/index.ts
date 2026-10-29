import type { Collector } from '../types';
import { agentCollectors } from './agents';
import { automationCollectors } from './automation';
import { claudeCollectors } from './claude';
import { editorCollectors } from './editors';
import { modelCollectors } from './models';
import { openaiGoogleCollectors } from './openai-google';
import { worktreeCollectors } from './worktrees';

/** Tudo o que a tela de IA lê, ferramenta por ferramenta. */
export const COLLECTORS: Collector[] = [
  ...claudeCollectors,
  ...worktreeCollectors,
  ...openaiGoogleCollectors,
  ...editorCollectors,
  ...agentCollectors,
  ...modelCollectors,
  ...automationCollectors,
];
