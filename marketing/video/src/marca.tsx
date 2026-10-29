import { continueRender, delayRender, staticFile } from 'remotion';

import { APP } from './app';

export const COR = APP.cores;

/** O degradê da marca: o azul → ciano do ícone. */
export const DEGRADE = `linear-gradient(135deg, ${COR.marcaFunda} 0%, ${COR.marca} 38%, ${COR.secundaria} 72%, ${COR.secundariaClara} 100%)`;

export const FONTE = `${APP.fonte.nome}, system-ui, sans-serif`;
export const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';

/** `#2563eb` com transparência, para os brilhos e as sombras. */
export function alfa(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const carga = delayRender(APP.fonte.nome);
const face = new FontFace(APP.fonte.nome, `url(${staticFile(APP.fonte.arquivo)}) format("${APP.fonte.formato}")`, {
  weight: '100 900'
});
face
  .load()
  .then((f) => {
    (document.fonts as unknown as { add: (f: FontFace) => void }).add(f);
    continueRender(carga);
  })
  .catch(() => continueRender(carga));

/** O selo do recurso pago, igual ao do app: pílula escura com um ponto em degradê. */
export function Selo({ texto, escala = 1 }: { texto: string; escala?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8 * escala,
        padding: `${6 * escala}px ${16 * escala}px`,
        borderRadius: 999,
        background: COR.tinta,
        color: COR.branco,
        fontFamily: FONTE,
        fontWeight: 800,
        fontSize: 22 * escala,
        letterSpacing: 0.5,
        boxShadow: `0 6px 18px ${alfa(COR.tinta, 0.18)}`
      }}
    >
      <span
        style={{
          width: 10 * escala,
          height: 10 * escala,
          borderRadius: 99,
          background: `linear-gradient(135deg, ${COR.marca}, ${COR.secundariaClara})`
        }}
      />
      {texto}
    </span>
  );
}
