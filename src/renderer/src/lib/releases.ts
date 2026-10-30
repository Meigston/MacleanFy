import type { Locale } from '../i18n/locale';

export interface ReleaseNote {
  title: string;
  text: string;
}

/**
 * O que cada versão trouxe, para o aviso que abre na primeira vez depois de instalar ou
 * atualizar. Versão sem entrada não abre aviso. O histórico completo fica nas releases
 * do GitHub; aqui entra só o que a pessoa nota ao abrir o app.
 */
export const RELEASE_NOTES: Record<string, Record<Locale, ReleaseNote[]>> = {
  '0.1.4': {
    'pt-BR': [
      {
        title: 'Sessões de IA',
        text: 'Tela nova com o que o Claude Code, o Codex, o Gemini, o Cursor, o Copilot, o LM Studio, o Ollama e outras ferramentas de IA deixam no disco: sessões, worktrees, caches, modelos baixados e versões antigas.',
      },
      {
        title: 'Frio e quente',
        text: 'O que está parado há mais de 7 dias aparece separado do que está em uso, por ferramenta ou por projeto. “Marcar o que está frio” só pega o que tem data de uso confiável.',
      },
      {
        title: 'Sem perder trabalho',
        text: 'Sessão aberta, app aberto e worktree com mudanças ficam bloqueados. Quase tudo vai para a Lixeira; worktrees saem pelo git, com o branch preservado, e modelos do Ollama pelo próprio Ollama. Configurações, credenciais e memórias nunca aparecem para remover.',
      },
    ],
    en: [
      {
        title: 'AI sessions',
        text: 'A new screen shows what Claude Code, Codex, Gemini, Cursor, Copilot, LM Studio, Ollama and other AI tools leave on disk: sessions, worktrees, caches, downloaded models and old versions.',
      },
      {
        title: 'Cold and hot',
        text: 'What has sat unused for more than 7 days is kept apart from what is in use, by tool or by project. “Tick what is cold” only picks items with a reliable last-use date.',
      },
      {
        title: 'No lost work',
        text: 'Open sessions, open apps and worktrees with changes are locked. Almost everything goes to the Trash; worktrees are removed through git and keep their branch, and Ollama models through Ollama itself. Settings, credentials and memories are never offered for removal.',
      },
    ],
  },
};

/** As novidades da versão no idioma da interface; um beta mostra as da versão que ele antecede. */
export function releaseNotes(version: string, locale: Locale): ReleaseNote[] | null {
  return RELEASE_NOTES[version.split('-')[0]]?.[locale] ?? null;
}
