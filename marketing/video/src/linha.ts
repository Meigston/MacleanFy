import roteiro from '../roteiro.json';
import manifesto from './manifesto.json';

/** Como o vídeo é montado: aparelho e texto lado a lado, aparelho embaixo da legenda, ou a gravação ocupando tudo. */
export type Layout = 'horizontal' | 'vertical' | 'tela-cheia';

/**
 * Um vídeo de roteiro.json: `horizontal`, `vertical` ou qualquer outro nome
 * (`appstore`, `play`) com `layout` dizendo como montar.
 */
interface Bloco {
  layout?: Layout;
  /** Tamanho do vídeo; sem ele, o padrão do layout. */
  largura?: number;
  altura?: number;
  /** O que o final mostra além do nome e do slogan (padrão: os dois). */
  final?: { lojas?: boolean; site?: boolean };
  /** As cenas, na ordem. Cada uma tem uma fala em `falas[lang][i]`. */
  cenas: string[];
  /** Segundos a mais que a cena segura além da fala (animação, respiro). */
  extra: Record<string, number>;
  falas: Record<string, string[]>;
}

const ROTEIRO = roteiro as unknown as { tempo: { fps: number; antes: number; depois: number; minimo: number } } & Record<
  string,
  unknown
>;
const MEDIDAS = manifesto as Record<string, { duracao: number | null }>;

export const FPS = ROTEIRO.tempo.fps;

/** O primeiro idioma de `roteiro.json`: a tomada que falta num idioma sai deste. */
export const IDIOMA_BASE = Object.keys((roteiro as { idiomas: Record<string, string> }).idiomas)[0];

const TAMANHO: Record<Layout, [number, number]> = {
  horizontal: [1920, 1080],
  vertical: [1080, 1920],
  // A prévia da App Store aceita 886×1920 para todos os iPhones com Face ID.
  'tela-cheia': [886, 1920]
};

function bloco(nome: string): Bloco | undefined {
  const b = ROTEIRO[nome] as Bloco | undefined;
  return b && Array.isArray(b.cenas) ? b : undefined;
}

/** Os vídeos de roteiro.json (as chaves que têm `cenas`). */
export function blocos(): string[] {
  return Object.keys(ROTEIRO).filter((k) => bloco(k));
}

export function layout(nome: string): Layout {
  return bloco(nome)?.layout ?? (nome === 'vertical' ? 'vertical' : 'horizontal');
}

export function tamanho(nome: string): [number, number] {
  const b = bloco(nome);
  const [l, a] = TAMANHO[layout(nome)];
  return [b?.largura ?? l, b?.altura ?? a];
}

export function final(nome: string) {
  const f = bloco(nome)?.final;
  return { lojas: f?.lojas ?? true, site: f?.site ?? true };
}

export interface Trecho {
  id: string;
  /** Primeiro quadro da cena. */
  de: number;
  quadros: number;
  /** A narração da cena, em public/. */
  voz: string;
  /** Quadro (relativo à cena) em que a narração começa. */
  vozDe: number;
  vozQuadros: number;
}

/** Os idiomas que têm falas neste vídeo; cada um vira uma composição. */
export function idiomas(nome: string): string[] {
  return Object.keys(bloco(nome)?.falas ?? {});
}

const dois = (i: number) => String(i + 1).padStart(2, '0');

/**
 * A linha do tempo sai da narração: cada cena dura o respiro antes da fala, a
 * fala, o respiro depois e o extra dela, nunca menos que o mínimo.
 * `scripts/legendas.mjs` repete esta conta a partir do mesmo roteiro.json.
 */
export function linha(nome: string, lang: string) {
  const b = bloco(nome);
  const { antes, depois, minimo } = ROTEIRO.tempo;
  const trechos: Trecho[] = [];
  let de = 0;
  (b?.cenas ?? []).forEach((id, i) => {
    const arquivo = `voz/${nome}-${lang}-${dois(i)}.mp3`;
    const fala = MEDIDAS[arquivo]?.duracao ?? 3;
    const segundos = Math.max(minimo, antes + fala + depois + (b?.extra[id] ?? 0));
    const quadros = Math.round(segundos * FPS);
    trechos.push({
      id,
      de,
      quadros,
      voz: arquivo,
      vozDe: Math.round(antes * FPS),
      vozQuadros: Math.ceil(fala * FPS)
    });
    de += quadros;
  });
  return { trechos, total: Math.max(1, de) };
}
