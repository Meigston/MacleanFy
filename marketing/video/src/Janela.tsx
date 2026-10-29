import { interpolate, useCurrentFrame } from 'remotion';

import { COR, FONTE } from './marca';
import { Gravacao, existe, type Tomada } from './Telefone';

/** A janela do app no Mac: 1180×760 pontos, gravada a 2×. */
const PROPORCAO = 760 / 1180;

/**
 * Para onde a câmera olha dentro da janela: o zoom e o ponto (de 0 a 1) que fica
 * parado. A câmera vai de `de` a `para` ao longo da cena.
 */
export interface Foco {
  de: [zoom: number, x: number, y: number];
  para?: [zoom: number, x: number, y: number];
}

/** Os três botões do canto, onde o app os põe (trafficLightPosition 20, 22). */
function Semaforo({ escala }: { escala: number }) {
  const cores = ['#ff5f57', '#febc2e', '#28c840'];
  return (
    <div style={{ position: 'absolute', left: 20 * escala, top: 22 * escala, display: 'flex', gap: 8 * escala }}>
      {cores.map((cor) => (
        <span
          key={cor}
          style={{
            width: 12 * escala,
            height: 12 * escala,
            borderRadius: 99,
            background: cor,
            boxShadow: `inset 0 0 0 ${0.5 * escala}px rgba(0,0,0,.18)`
          }}
        />
      ))}
    </div>
  );
}

/** A tela gravada dentro de uma janela do macOS, com borda, sombra e o brilho da marca. */
export function Janela({
  tomadas,
  largura,
  quadros,
  rotulo,
  foco
}: {
  tomadas: (Tomada | undefined)[];
  largura: number;
  quadros: number;
  rotulo?: string;
  foco?: Foco;
}) {
  const frame = useCurrentFrame();
  const lista = tomadas.filter((t): t is Tomada => !!t && existe(t.arquivo));
  const altura = largura * PROPORCAO;
  const escala = largura / 1180;
  const raio = 14 * escala;

  const de = foco?.de ?? [1, 0.5, 0.5];
  const para = foco?.para ?? de;
  const k = interpolate(frame, [0, quadros], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const suave = k * k * (3 - 2 * k);
  const [zoom, x, y] = de.map((v, i) => v + (para[i] - v) * suave);

  return (
    <div
      style={{
        width: largura,
        height: altura,
        borderRadius: raio,
        position: 'relative',
        overflow: 'hidden',
        background: COR.tinta,
        boxShadow: [
          `0 0 0 ${Math.max(1, escala)}px rgba(164,184,255,.22)`,
          `0 ${50 * escala}px ${110 * escala}px rgba(0,0,12,.6)`,
          `0 0 ${160 * escala}px rgba(31,157,255,.22)`
        ].join(', ')
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${zoom})`,
          transformOrigin: `${x * 100}% ${y * 100}%`
        }}
      >
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
              fontSize: largura * 0.04
            }}
          >
            {rotulo ?? 'gravação'}
          </div>
        )}
        <Semaforo escala={escala} />
      </div>
    </div>
  );
}
