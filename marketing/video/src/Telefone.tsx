import { Img, OffthreadVideo, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { COR, FONTE } from './marca';
import manifesto from './manifesto.json';

export interface Tomada {
  /** Caminho dentro de public/ (mp4 ou png). */
  arquivo: string;
  /** Segundo da gravação em que o trecho começa. */
  inicio?: number;
  /** Segundo em que ele acaba; sem ele, vai até o fim da gravação. */
  fim?: number;
  /** Quanto tempo uma imagem parada fica (png). */
  segundos?: number;
  plataforma: 'ios' | 'android' | 'mac';
}

const MEDIDAS = manifesto as Record<string, { duracao: number | null; largura: number | null; altura: number | null }>;

/** Existe em public/? A montagem roda antes de todas as gravações chegarem. */
export function existe(arquivo?: string): boolean {
  return !!arquivo && arquivo in MEDIDAS;
}

const video = (t: Tomada) => /\.mp4$/i.test(t.arquivo);

/** Duração do trecho na gravação, em segundos. */
function trecho(t: Tomada): number {
  if (!video(t)) return t.segundos ?? 2.5;
  const inicio = t.inicio ?? 0;
  const fim = t.fim ?? MEDIDAS[t.arquivo]?.duracao ?? inicio + 3;
  return Math.max(0.4, fim - inicio);
}

function Tela({ tomada, quadros, ritmo }: { tomada: Tomada; quadros: number; ritmo: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (video(tomada)) {
    const inicio = tomada.inicio ?? 0;
    const fim = tomada.fim ?? MEDIDAS[tomada.arquivo]?.duracao ?? inicio + 3;
    return (
      <OffthreadVideo
        src={staticFile(tomada.arquivo)}
        startFrom={Math.round(inicio * fps)}
        endAt={Math.round(fim * fps)}
        playbackRate={ritmo}
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );
  }
  const zoom = interpolate(frame, [0, quadros], [1, 1.05], { extrapolateRight: 'clamp' });
  return (
    <Img
      src={staticFile(tomada.arquivo)}
      style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${zoom})`, transformOrigin: 'top center' }}
    />
  );
}

/**
 * Os trechos de gravação em sequência, todos no mesmo ritmo, acelerado ou
 * desacelerado (de 0,6× a 1,7×) para o conjunto caber na cena. Fora disso o
 * último trecho segura o último quadro, que é melhor do que cortar o gesto no
 * meio. Ocupa o elemento em que está (a tela do Telefone, ou o vídeo inteiro).
 */
export function Gravacao({ tomadas, quadros }: { tomadas: Tomada[]; quadros: number }) {
  const { fps } = useVideoConfig();
  const total = tomadas.reduce((s, t) => s + trecho(t), 0);
  const ritmo = Math.min(1.7, Math.max(0.6, total / (quadros / fps)));
  let de = 0;
  const pedacos = tomadas.map((t, i) => {
    const ultimo = i === tomadas.length - 1;
    const n = ultimo ? Math.max(1, quadros - de) : Math.max(1, Math.round((trecho(t) / ritmo) * fps));
    const p = { t, de, n };
    de += n;
    return p;
  });
  return (
    <>
      {pedacos.map(({ t, de: inicio, n }, i) => (
        <Sequence key={i} from={inicio} durationInFrames={n} layout="absolute-fill">
          <Tela tomada={t} quadros={n} ritmo={ritmo} />
        </Sequence>
      ))}
    </>
  );
}

/** A tela gravada dentro de um aparelho desenhado. */
export function Telefone({
  tomadas,
  largura,
  quadros,
  rotulo
}: {
  tomadas: (Tomada | undefined)[];
  largura: number;
  quadros: number;
  rotulo?: string;
}) {
  const lista = tomadas.filter((t): t is Tomada => !!t && existe(t.arquivo));
  const primeira = lista[0];
  const ios = (primeira?.plataforma ?? tomadas.find(Boolean)?.plataforma ?? 'ios') === 'ios';
  const medida = primeira && MEDIDAS[primeira.arquivo];
  const proporcao = medida?.largura && medida?.altura ? medida.altura / medida.largura : ios ? 2532 / 1170 : 2400 / 1080;
  const borda = largura * 0.032;
  const altura = largura * proporcao;
  const raio = largura * (ios ? 0.15 : 0.11);

  return (
    <div
      style={{
        width: largura + borda * 2,
        height: altura + borda * 2,
        borderRadius: raio + borda,
        background: '#0f172a',
        padding: borda,
        boxShadow: '0 40px 80px rgba(11,18,32,.28), 0 12px 24px rgba(11,18,32,.18)',
        position: 'relative'
      }}
    >
      <div style={{ width: largura, height: altura, borderRadius: raio, overflow: 'hidden', position: 'relative', background: '#e2e8f0' }}>
        {lista.length ? (
          <Gravacao tomadas={lista} quadros={quadros} />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: COR.apagado,
              fontFamily: FONTE,
              fontWeight: 700,
              fontSize: largura * 0.06,
              textAlign: 'center',
              padding: largura * 0.1
            }}
          >
            {rotulo ?? 'gravação'}
          </div>
        )}
      </div>
    </div>
  );
}
