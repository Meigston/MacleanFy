import type { Foco } from './Janela';
import { IDIOMA_BASE } from './linha';
import manifesto from './manifesto.json';
import type { Tomada } from './Telefone';

const CHAVES = new Set(Object.keys(manifesto as Record<string, unknown>));

type Trecho = [arquivo: string, inicio?: number, fim?: number];

/** Um trecho da gravação do Mac, no idioma pedido (o base se faltar). */
function t(lang: string, [arquivo, inicio, fim]: Trecho): Tomada | undefined {
  for (const l of [lang, IDIOMA_BASE]) {
    const caminho = `brutos/mac/${l}/${arquivo}`;
    if (CHAVES.has(caminho)) return { arquivo: caminho, plataforma: 'mac', inicio, fim };
  }
  return undefined;
}

const mac = (lang: string, ...trechos: Trecho[]) => trechos.map((x) => t(lang, x));

export interface Plano {
  tomadas: (Tomada | undefined)[];
  foco?: Foco;
}

/*
 * As gravações saem de cenas/<cena>.mjs (scripts/gravar.sh), com as marcas de
 * tempo em brutos/mac/<idioma>/<cena>.json; os cortes abaixo saem delas e das
 * folhas de contato. O gravador é determinístico: pt e en têm os mesmos tempos.
 * Os trechos tocam em sequência, acelerados até 1,7× para caber na fala.
 */

/** O horizontal: a janela de um lado e o título do outro. */
export function planoHorizontal(cena: string, lang: string): Plano {
  switch (cena) {
    case 'visao-geral':
      // Analisar na própria Visão geral: os cartões se enchem.
      return { tomadas: mac(lang, ['visao-geral.mp4', 1.6, 10.6]), foco: { de: [1, 0.5, 0.5], para: [1.04, 0.55, 0.35] } };
    case 'limpeza':
      // As 17 categorias chegando, a rolagem e uma categoria aberta.
      return { tomadas: mac(lang, ['limpeza.mp4', 1.7, 12.6]), foco: { de: [1, 0.5, 0.5], para: [1.04, 0.5, 0.5] } };
    case 'seguranca':
      // O "Seguro" marcado, Limpar, a confirmação com "Só simular", o espaço liberado.
      return {
        tomadas: mac(lang, ['seguranca.mp4', 1.9, 4.7], ['seguranca.mp4', 5.0, 8.4], ['seguranca.mp4', 9.7, 11.6]),
        foco: { de: [1, 0.5, 0.5], para: [1.05, 0.5, 0.5] }
      };
    case 'disco':
      // Medir, abrir Downloads, mandar o Xcode velho para a Lixeira.
      return {
        tomadas: mac(lang, ['disco.mp4', 1.7, 5.0], ['disco.mp4', 5.8, 7.8], ['disco.mp4', 8.6, 13.4]),
        foco: { de: [1, 0.5, 0.5], para: [1.04, 0.5, 0.45] }
      };
    case 'desinstalador':
      // Abrir o zoom.us, marcar, a confirmação com os arquivos de sistema, removido.
      return {
        tomadas: mac(
          lang,
          ['desinstalador.mp4', 1.5, 4.2],
          ['desinstalador.mp4', 6.9, 10.6],
          ['desinstalador.mp4', 12.4, 13.3],
          ['desinstalador.mp4', 15.2, 16.6]
        ),
        foco: { de: [1, 0.5, 0.5], para: [1.04, 0.5, 0.45] }
      };
    case 'desempenho':
      // O diagnóstico, as métricas ao vivo e os itens em segundo plano.
      return {
        tomadas: mac(lang, ['desempenho.mp4', 1.0, 4.4], ['desempenho.mp4', 4.4, 7.6], ['desempenho.mp4', 11.2, 14.6]),
        foco: { de: [1, 0.5, 0.5], para: [1.04, 0.5, 0.4] }
      };
    case 'manutencao':
      // Quick Look rodando e concluído, depois o .DS_Store desligado com um clique.
      return {
        tomadas: mac(lang, ['manutencao.mp4', 1.6, 5.0], ['manutencao.mp4', 8.6, 11.8]),
        foco: { de: [1, 0.5, 0.5], para: [1.04, 0.5, 0.5] }
      };
    default:
      return { tomadas: [] };
  }
}

/**
 * O vertical: a janela embaixo da legenda, com a câmera chegando um pouco mais
 * perto. Acima de ~1,15× o zoom corta a caixa de marcar ou os tamanhos.
 */
export function planoVertical(cena: string, lang: string): Plano {
  switch (cena) {
    case 'limpeza':
      return { tomadas: mac(lang, ['limpeza.mp4', 2.0, 7.4]), foco: { de: [1, 0.53, 0.3], para: [1.14, 0.53, 0.45] } };
    case 'disco':
      return {
        tomadas: mac(lang, ['disco.mp4', 2.0, 5.0], ['disco.mp4', 5.9, 7.8]),
        foco: { de: [1, 0.53, 0.4], para: [1.14, 0.53, 0.5] }
      };
    case 'desinstalador':
      return { tomadas: mac(lang, ['desinstalador.mp4', 1.6, 4.6]), foco: { de: [1, 0.53, 0.3], para: [1.14, 0.53, 0.4] } };
    case 'desempenho':
      return { tomadas: mac(lang, ['desempenho.mp4', 1.0, 4.6]), foco: { de: [1, 0.53, 0.15], para: [1.14, 0.53, 0.2] } };
    default:
      return { tomadas: [] };
  }
}
