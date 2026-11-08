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
  '0.1.6': {
    'pt-BR': [
      {
        title: 'O disco inteiro',
        text: 'Na Visão geral, o cartão Saúde do Mac agora abre o disco inteiro numa barra: o que é do macOS e não dá para mexer (sistema, inicialização e recuperação, memória virtual e arquivos do sistema), o que o macOS protege e não deixa identificar, e o que é seu, com um atalho para onde cada parte é limpa ou aberta.',
      },
      {
        title: 'A pasta pessoal em fatias',
        text: 'Desenvolvimento, IA, caches, iCloud, Fotos, Mail, Mensagens, Lixeira, dados de apps e o resto, e “Como a conta fecha” mostra como as partes somam o disco inteiro. Depois de uma limpeza, a medida avisa que ficou velha e pode ser refeita com um clique.',
      },
      {
        title: 'Simuladores e emuladores',
        text: 'Em Desenvolvimento, cada simulador do iOS e cada emulador do Android aparece com a versão do sistema, quando foi aberto e quanto ocupa. Os que não abrem mais ganham um aviso, e os que estão abertos não podem ser marcados.',
      },
    ],
    en: [
      {
        title: 'The whole disk',
        text: 'On the Overview, the Mac health card now opens the whole disk in one bar: what belongs to macOS and can’t be changed (system, startup and recovery, virtual memory and system files), what macOS protects and won’t let the app identify, and what is yours, with a shortcut to where each part is cleaned or opened.',
      },
      {
        title: 'Your home folder in slices',
        text: 'Development, AI, caches, iCloud, Photos, Mail, Messages, Trash, app data and the rest, and “How the numbers add up” shows how the parts make up the whole disk. After a cleanup, the measurement says it is out of date and can be redone with one click.',
      },
      {
        title: 'Simulators and emulators',
        text: 'Under Development, each iOS simulator and Android emulator shows up with its system version, when it was last opened and how much space it takes. The ones that no longer open get a warning, and the ones that are open can’t be ticked.',
      },
    ],
  },
  '0.1.5': {
    'pt-BR': [
      {
        title: 'Apps ao entrar na conta',
        text: 'Em Desempenho, a lista “Abrir ao iniciar sessão” dos Ajustes aparece com um interruptor para cada app. Ao clicar em “Mostrar apps”, o macOS pergunta uma vez se o MacleanFy pode controlar os Eventos do Sistema; sem a sua permissão, nada é lido.',
      },
      {
        title: 'Desligar o que abre sozinho',
        text: 'Os itens em segundo plano agora incluem os ajudantes de login que os apps cadastram, e os que abrem sozinhos ganham um interruptor. Desligar vale a partir do próximo login, só na sua conta e sem senha: o que está aberto continua aberto.',
      },
      {
        title: 'Serviços do sistema',
        text: 'Os que pedem a senha de administrador ganham um botão que abre Itens de Início, nos Ajustes do Mac, onde dá para desligá-los.',
      },
    ],
    en: [
      {
        title: 'Apps at login',
        text: 'Under Performance, the “Open at Login” list from Settings shows up with a switch for each app. When you click “Show apps”, macOS asks once whether MacleanFy may control System Events; without your permission, nothing is read.',
      },
      {
        title: 'Turn off what opens on its own',
        text: 'Background items now include the login helpers that apps register, and the ones that open on their own get a switch. Turning one off takes effect at your next login, only in your account and without a password: what is open stays open.',
      },
      {
        title: 'System services',
        text: 'The ones that need the administrator password get a button that opens Login Items in your Mac’s settings, where you can turn them off.',
      },
    ],
  },
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
