// Nivela o volume da narração e da música (EBU R128, duas passadas do loudnorm,
// ganho linear: não mexe na dinâmica). Voz clonada sai com volume diferente a
// cada geração, e uma música mais alta encobre a voz; sem isto a mistura de
// src/trilha.ts (0,5 solta, 0,13 sob a voz) muda de música para música.
// Os originais ficam em public/originais/, e rodar de novo parte deles.
// Uso: node scripts/normalizar.mjs            (voz a -16 LUFS, música a -18)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const raiz = new URL('..', import.meta.url).pathname;
const publico = join(raiz, 'public');
const ALVO = { voz: -16, musica: -18 };
const PICO = -1.5;

/** Primeira passada: a medida do arquivo (o ffmpeg a escreve no stderr, em JSON). */
function medir(arquivo, alvo) {
  const saida = execFileSync(
    'sh',
    ['-c', `ffmpeg -hide_banner -i "$1" -af "loudnorm=I=${alvo}:TP=${PICO}:LRA=11:print_format=json" -f null - 2>&1`, 'sh', arquivo],
    { encoding: 'utf8' }
  );
  return JSON.parse(saida.slice(saida.lastIndexOf('{'), saida.lastIndexOf('}') + 1));
}

for (const [pasta, alvo] of Object.entries(ALVO)) {
  const dir = join(publico, pasta);
  if (!existsSync(dir)) continue;
  const guarda = join(publico, 'originais', pasta);
  mkdirSync(guarda, { recursive: true });
  for (const nome of readdirSync(dir).filter((n) => n.endsWith('.mp3')).sort()) {
    const arquivo = join(dir, nome);
    const original = join(guarda, nome);
    if (!existsSync(original)) copyFileSync(arquivo, original);
    const m = medir(original, alvo);
    // Segunda passada: ganho linear com a medida da primeira.
    const filtro =
      `loudnorm=I=${alvo}:TP=${PICO}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
      `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
    const temp = join(dir, `.${nome}`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', original, '-af', filtro, '-ar', '48000', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', temp]);
    renameSync(temp, arquivo);
    console.log(`${pasta}/${nome}: ${m.input_i} → ${medir(arquivo, alvo).input_i} LUFS`);
  }
}
