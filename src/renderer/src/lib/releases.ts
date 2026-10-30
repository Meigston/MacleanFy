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
        text: 'O que está parado há mais de 7 dias aparece como frio, junto com sobras como versões antigas e temporários sem dono; dá para ver por ferramenta ou por projeto. “Marcar o que está frio” só pega o que se sabe parado: modelos que só têm a data do download e conversas com imagens geradas ficam para você marcar à mão.',
      },
      {
        title: 'Sem perder trabalho',
        text: 'Sessão aberta, app aberto e worktree com mudanças ficam bloqueados. Quase tudo vai para a Lixeira, inclusive as worktrees, que depois saem da lista do git com o branch preservado. Modelos do Ollama saem pelo próprio Ollama, que precisa estar aberto, e são apagados de vez. Configurações, credenciais e memórias nunca aparecem para remover.',
      },
    ],
    en: [
      {
        title: 'AI sessions',
        text: 'A new screen shows what Claude Code, Codex, Gemini, Cursor, Copilot, LM Studio, Ollama and other AI tools leave on disk: sessions, worktrees, caches, downloaded models and old versions.',
      },
      {
        title: 'Cold and hot',
        text: 'Anything unused for more than 7 days shows as cold, along with leftovers such as old versions and orphaned temporary files; you can view it by tool or by project. “Tick what is cold” only picks what is known to be idle: models with only a download date and conversations with generated images are left for you to tick by hand.',
      },
      {
        title: 'No lost work',
        text: 'Open sessions, open apps and worktrees with changes are locked. Almost everything goes to the Trash, worktrees included; git then drops them from its list and their branch stays. Ollama models are removed through Ollama, which must be running, and are deleted for good. Settings, credentials and memories are never offered for removal.',
      },
    ],
  },
};

/** A versão das notas: um beta mostra as da versão que ele antecede. */
const base = (version: string) => version.split('-')[0];

export function hasReleaseNotes(version: string): boolean {
  return Object.hasOwn(RELEASE_NOTES, base(version));
}

/** As novidades da versão no idioma da interface. */
export function releaseNotes(version: string, locale: Locale): ReleaseNote[] | null {
  return hasReleaseNotes(version) ? RELEASE_NOTES[base(version)][locale] : null;
}
