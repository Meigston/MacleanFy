/*
 * A identidade do MacleanFy e os textos da tela, por idioma. A narração fica em
 * roteiro.json; os trechos das gravações de cada cena, em tomadas.ts.
 */

export const APP = {
  nome: 'MacleanFy',
  site: 'macleanfy.com',
  /** Onde fica o código: a chamada do final pede uma estrela lá. */
  repositorio: 'github.com/Meigston/MacleanFy',
  /** O MacleanFy é todo grátis: nenhuma cena leva o selo de recurso pago. */
  selo: '',
  /** Sem a faixa corrida: o app não tem um fio de assunto como códigos de aeroporto. */
  faixa: '',
  /** A Inter do app, de peso variável (100 a 900). */
  fonte: { nome: 'Inter', arquivo: 'fonts/Inter.woff2', formato: 'woff2' },
  /**
   * A dor da abertura e do gancho do vertical. Ícones: disco, lento, cartao e os
   * outros de pecas.tsx.
   */
  chips: [
    { icone: 'disco', cor: '#e5484d' },
    { icone: 'lento', cor: '#f0a020' },
    { icone: 'cartao', cor: '#8b5cf6' }
  ],
  /** As cores do app (src/renderer/src/theme/tokens.css). O vídeo é todo escuro, como o app. */
  cores: {
    /** O fundo mais fundo, das aberturas e do final. */
    tinta: '#05001d',
    /** O fundo das cenas de recurso. */
    papel: '#0b0745',
    titulo: '#eef0ff',
    corpo: '#b9bfde',
    apagado: '#8d93b8',
    marca: '#1f9dff',
    marcaFunda: '#0a4fc9',
    secundaria: '#4fc6ff',
    secundariaClara: '#13fafe',
    branco: '#ffffff'
  }
};

export interface Cena {
  /** Rótulo pequeno em cima do título, como as seções de um site. */
  kicker?: string;
  titulo: string;
  apoio?: string;
  /** Recurso pago: a cena leva o selo. */
  selo?: boolean;
}

export interface Textos {
  /** O texto de cada chip da abertura, na ordem de APP.chips. */
  chips: [string, string, string];
  pergunta: string;
  /** As cenas de recurso do horizontal, pelo id de roteiro.json. */
  cenas: Record<string, Cena>;
  slogan: string;
  /** A chamada do final, ao lado da estrela. */
  estrela: string;
  /** O vertical: o texto grande do gancho e a legenda de cada cena de recurso. */
  vertical?: { gancho: string; cenas: Record<string, { legenda: string; selo?: boolean }> };
}

export const TEXTOS: Record<string, Textos> = {
  pt: {
    chips: ['Disco cheio', 'Mac lento', 'Limpador por assinatura'],
    pergunta: 'E se fosse grátis e de código aberto?',
    cenas: {
      'visao-geral': {
        kicker: 'Visão geral',
        titulo: 'Seu Mac inteiro numa tela',
        apoio: 'Saúde do Mac, espaço recuperável e o que você já liberou.'
      },
      limpeza: {
        kicker: 'Limpeza inteligente',
        titulo: '17 categorias. Uma análise.',
        apoio: 'Caches, logs, sobras de desenvolvimento, navegadores e duplicados.'
      },
      seguranca: {
        kicker: 'Segurança',
        titulo: 'Nada sai sem você confirmar',
        apoio: 'Só o que é seguro vem marcado. Dá até para simular antes.'
      },
      disco: {
        kicker: 'Espaço em disco',
        titulo: 'Descubra para onde foi o espaço',
        apoio: 'Pasta por pasta, do maior para o menor.'
      },
      desinstalador: {
        kicker: 'Desinstalador',
        titulo: 'O app e as sobras, de uma vez',
        apoio: 'O app, o que ele deixou na Biblioteca e os serviços no sistema.'
      },
      desempenho: {
        kicker: 'Desempenho',
        titulo: 'Por que o Mac está lento?',
        apoio: 'Processador, memória, rede e bateria ao vivo, com o diagnóstico.'
      },
      manutencao: {
        kicker: 'Manutenção',
        titulo: 'Sem Terminal. Um botão.',
        apoio: 'DNS, Quick Look, Spotlight e snapshots do Time Machine.'
      }
    },
    slogan: 'Grátis. Código aberto.',
    estrela: 'Deixe uma estrela no GitHub',
    vertical: {
      gancho: 'Mac sem espaço?',
      cenas: {
        limpeza: { legenda: '17 categorias, e só o seguro vem marcado' },
        disco: { legenda: 'Veja para onde foi o espaço' },
        desinstalador: { legenda: 'Desinstale apps junto com as sobras' },
        desempenho: { legenda: 'Descubra o que deixa o Mac lento' }
      }
    }
  },
  en: {
    chips: ['Disk full', 'Mac slow', 'Cleaner subscription'],
    pergunta: 'What if it were free and open source?',
    cenas: {
      'visao-geral': {
        kicker: 'Overview',
        titulo: 'Your whole Mac on one screen',
        apoio: "Mac health, reclaimable space and what you've freed."
      },
      limpeza: {
        kicker: 'Smart clean',
        titulo: '17 categories. One scan.',
        apoio: 'Caches, logs, developer leftovers, browsers and duplicates.'
      },
      seguranca: {
        kicker: 'Safety',
        titulo: 'Nothing goes without your OK',
        apoio: "Only what's safe comes ticked. You can even do a dry run."
      },
      disco: {
        kicker: 'Disk space',
        titulo: 'Find where your space went',
        apoio: 'Folder by folder, biggest first.'
      },
      desinstalador: {
        kicker: 'Uninstaller',
        titulo: 'The app and its leftovers, in one go',
        apoio: 'The app, what it left in Library and its system services.'
      },
      desempenho: {
        kicker: 'Performance',
        titulo: 'Why is your Mac slow?',
        apoio: 'Processor, memory, network and battery live, with a diagnosis.'
      },
      manutencao: {
        kicker: 'Maintenance',
        titulo: 'No Terminal. One button.',
        apoio: 'DNS, Quick Look, Spotlight and Time Machine snapshots.'
      }
    },
    slogan: 'Free. Open source.',
    estrela: 'Leave a star on GitHub',
    vertical: {
      gancho: 'Mac out of space?',
      cenas: {
        limpeza: { legenda: "17 categories, and only what's safe comes ticked" },
        disco: { legenda: 'See where your space went' },
        desinstalador: { legenda: 'Uninstall apps, leftovers and all' },
        desempenho: { legenda: "Find out what's slowing your Mac" }
      }
    }
  }
};
