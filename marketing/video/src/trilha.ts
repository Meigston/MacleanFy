import { interpolate } from 'remotion';

import type { Trecho } from './linha';

const SOLTA = 0.5;
const SOB_VOZ = 0.13;
const RAMPA = 9;

/**
 * Volume da música no quadro: cheia nos respiros, baixa enquanto a narração
 * fala (com rampa, para não "bombear"), entrada suave e saída no fim.
 */
export function volumeMusica(frame: number, trechos: Trecho[], total: number): number {
  let falando = 0;
  for (const t of trechos) {
    const de = t.de + t.vozDe;
    const ate = de + t.vozQuadros;
    const peso = interpolate(frame, [de - RAMPA, de, ate, ate + RAMPA], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp'
    });
    falando = Math.max(falando, peso);
  }
  const base = SOLTA - (SOLTA - SOB_VOZ) * falando;
  const entrada = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const fim = interpolate(frame, [total - 30, total], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return base * entrada * fim;
}
