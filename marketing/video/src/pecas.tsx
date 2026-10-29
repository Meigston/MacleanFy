import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import { APP } from './app';
import { COR, DEGRADE, FONTE, MONO, alfa } from './marca';
import { existe } from './Telefone';

/**
 * Entra de baixo, com mola, depois de `atraso` quadros. Devolve um transform:
 * num elemento que já tem transform de posição, aplicar num div de dentro,
 * senão um apaga o outro.
 */
export function useEntrada(atraso = 0, distancia = 40) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = spring({ frame: frame - atraso, fps, config: { damping: 200, mass: 0.8 } });
  return { opacity: t, transform: `translateY(${(1 - t) * distancia}px)` } as CSSProperties;
}

/** Some nos últimos quadros da cena, para a troca não ser um corte seco. */
export function useSaida(quadros: number, duracao = 8) {
  const frame = useCurrentFrame();
  return interpolate(frame, [quadros - duracao, quadros], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp'
  });
}

/** Fundo escuro da marca, com o brilho do degradê se mexendo devagar. */
export function FundoEscuro({ children }: { children?: ReactNode }) {
  const frame = useCurrentFrame();
  const x = 50 + Math.sin(frame / 90) * 12;
  const y = 40 + Math.cos(frame / 110) * 10;
  return (
    <AbsoluteFill style={{ background: COR.tinta }}>
      <AbsoluteFill
        style={{
          background: DEGRADE,
          opacity: 0.55,
          maskImage: `radial-gradient(60% 70% at ${x}% ${y}%, black 0%, transparent 75%)`,
          WebkitMaskImage: `radial-gradient(60% 70% at ${x}% ${y}%, black 0%, transparent 75%)`
        }}
      />
      {children}
    </AbsoluteFill>
  );
}

/**
 * Fundo das cenas de recurso: o azul-marinho do app, com o brilho da marca atrás
 * da janela e um halo lilás no canto oposto, como o fundo do próprio app.
 */
export function FundoClaro({ ladoX, children }: { ladoX: number; children?: ReactNode }) {
  const frame = useCurrentFrame();
  const y = 50 + Math.sin(frame / 70) * 4;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(158deg, ${COR.papel} 0%, #090636 46%, ${COR.tinta} 100%)` }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(42% 62% at ${ladoX}% ${y}%, ${alfa(COR.marca, 0.34)} 0%, ${alfa(COR.secundariaClara, 0.08)} 48%, transparent 76%)`
        }}
      />
      <AbsoluteFill
        style={{ background: `radial-gradient(40% 50% at ${100 - ladoX}% 105%, rgba(92,82,236,.32) 0%, transparent 70%)` }}
      />
      {children}
    </AbsoluteFill>
  );
}

/** A faixa corrida: linha pontilhada e o fio do app (APP.faixa) passando. */
export function FaixaCorrida({ cor, y, tamanho = 22 }: { cor: string; y: number; tamanho?: number }) {
  const frame = useCurrentFrame();
  const desloca = -(frame * 1.2) % 1400;
  if (!APP.faixa) return null;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: y, overflow: 'hidden' }}>
      <div style={{ borderTop: `2px dashed ${cor}`, opacity: 0.35, margin: '0 0 14px' }} />
      <div
        style={{
          whiteSpace: 'nowrap',
          fontFamily: MONO,
          fontSize: tamanho,
          letterSpacing: 4,
          color: cor,
          opacity: 0.55,
          transform: `translateX(${desloca}px)`
        }}
      >
        {`${APP.faixa} · ${APP.faixa} · ${APP.faixa}`}
      </div>
    </div>
  );
}

export function Icone({ tamanho, style }: { tamanho: number; style?: CSSProperties }) {
  // Sem o ícone em public/ ainda, a inicial do app no degradê, para a prévia.
  if (!existe('marca/icon.png')) {
    return (
      <div
        style={{
          width: tamanho,
          height: tamanho,
          borderRadius: tamanho * 0.225,
          background: DEGRADE,
          color: COR.branco,
          fontFamily: FONTE,
          fontWeight: 800,
          fontSize: tamanho * 0.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
        }}
      >
        {APP.nome.slice(0, 1)}
      </div>
    );
  }
  return (
    <Img
      src={staticFile('marca/icon.png')}
      style={{ width: tamanho, height: tamanho, borderRadius: tamanho * 0.225, ...style }}
    />
  );
}

/** Ícones de traço (24×24) para os chips. Para outro, acrescentar aqui. */
const ICONES: Record<string, ReactNode> = {
  disco: (
    <>
      <path d="M22 12H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <path d="M6 16h.01M10 16h.01" />
    </>
  ),
  lento: (
    <>
      <path d="m12 14 2.5-4.5" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  hotel: (
    <>
      <path d="M3 18V8M3 14h18v4M21 18v-6a3 3 0 0 0-3-3h-7v5" />
      <circle cx="7" cy="11" r="2" />
    </>
  ),
  planilha: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
    </>
  ),
  documento: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h5" />
    </>
  ),
  foto: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <circle cx="12" cy="13" r="3.5" />
      <path d="M8.5 6l1.5-2h4l1.5 2" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  calendario: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  cartao: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20M6 15h4" />
    </>
  ),
  nota: (
    <>
      <path d="M5 3h10l4 4v14H5z" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </>
  )
};

/** Um dos "apps" de onde a coisa vem espalhada (abertura e gancho). */
export function Chip({ indice, texto, escala = 1 }: { indice: number; texto: string; escala?: number }) {
  const s = escala;
  const { icone, cor } = APP.chips[indice];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18 * s,
        padding: `${18 * s}px ${28 * s}px ${18 * s}px ${18 * s}px`,
        borderRadius: 24 * s,
        background: 'rgba(255,255,255,.08)',
        border: '1px solid rgba(255,255,255,.16)',
        backdropFilter: 'blur(6px)',
        color: COR.branco,
        fontFamily: FONTE,
        fontWeight: 700,
        fontSize: 30 * s,
        whiteSpace: 'nowrap'
      }}
    >
      <div
        style={{
          width: 60 * s,
          height: 60 * s,
          borderRadius: 16 * s,
          background: cor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <svg width={34 * s} height={34 * s} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2}>
          {ICONES[icone] ?? ICONES.nota}
        </svg>
      </div>
      {texto}
    </div>
  );
}

/** A estrela do GitHub com a chamada do final e o endereço do repositório embaixo. */
export function Estrela({ texto, repositorio, escala = 1, style }: { texto: string; repositorio: string; escala?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const brilho = 0.55 + Math.sin(frame / 9) * 0.25;
  const s = escala;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 * s, ...style }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 16 * s,
          padding: `${16 * s}px ${30 * s}px ${16 * s}px ${22 * s}px`,
          borderRadius: 999,
          background: 'rgba(255,255,255,.07)',
          border: `${1.5 * s}px solid rgba(245,196,81,.55)`,
          boxShadow: `0 0 ${40 * s}px rgba(245,196,81,${brilho * 0.35})`,
          color: COR.branco,
          fontFamily: FONTE,
          fontWeight: 700,
          fontSize: 38 * s,
          whiteSpace: 'nowrap'
        }}
      >
        <svg width={42 * s} height={42 * s} viewBox="0 0 24 24">
          <path
            d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"
            fill="#f5c451"
            stroke="#f5c451"
            strokeWidth={1.2}
            strokeLinejoin="round"
          />
        </svg>
        {texto}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 30 * s, letterSpacing: 1, color: 'rgba(255,255,255,.82)' }}>{repositorio}</div>
    </div>
  );
}
