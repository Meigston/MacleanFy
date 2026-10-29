// Legendas WebVTT de um formato, em todos os idiomas dele, com os tempos da
// narração. Repete a conta de src/linha.ts a partir do mesmo roteiro.json.
// Uso: node scripts/legendas.mjs <horizontal|vertical> [pasta de destino]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const raiz = new URL('..', import.meta.url).pathname;
const manifesto = JSON.parse(readFileSync(join(raiz, 'src/manifesto.json'), 'utf8'));
const roteiro = JSON.parse(readFileSync(join(raiz, 'roteiro.json'), 'utf8'));

const formato = process.argv[2];
const bloco = roteiro[formato];
if (!bloco) {
  console.error('uso: node scripts/legendas.mjs <horizontal|vertical> [destino]');
  process.exit(2);
}
const { fps: FPS, antes: ANTES, depois: DEPOIS, minimo: MINIMO } = roteiro.tempo;
const MAX_LINHA = 42;

const tempo = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const seg = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${seg}.${String(ms % 1000).padStart(3, '0')}`;
};

/** Frases curtas: corta no ponto, e a frase longa na vírgula ou nos dois-pontos. */
function pedacos(texto) {
  const frases = texto.match(/[^.!?¿¡]*[¿¡]?[^.!?]*[.!?]+|\S[^.!?]*$/g).map((f) => f.trim()).filter(Boolean);
  const saida = [];
  for (const frase of frases) {
    if (frase.length <= MAX_LINHA * 2) {
      saida.push(frase);
      continue;
    }
    // Frase longa: junta os trechos entre vírgulas até encher duas linhas.
    let atual = '';
    for (const trecho of frase.split(/(?<=[,:])\s+/)) {
      if (atual && atual.length + 1 + trecho.length > MAX_LINHA * 2) {
        saida.push(atual);
        atual = trecho;
      } else {
        atual = atual ? `${atual} ${trecho}` : trecho;
      }
    }
    if (atual) saida.push(atual);
  }
  return saida;
}

/** Quebra em até duas linhas equilibradas. */
function linhas(texto) {
  if (texto.length <= MAX_LINHA) return texto;
  const palavras = texto.split(' ');
  let melhor = texto;
  let diferenca = Infinity;
  for (let i = 1; i < palavras.length; i++) {
    const a = palavras.slice(0, i).join(' ');
    const b = palavras.slice(i).join(' ');
    const d = Math.abs(a.length - b.length);
    if (d < diferenca && a.length <= MAX_LINHA + 6 && b.length <= MAX_LINHA + 6) {
      diferenca = d;
      melhor = `${a}\n${b}`;
    }
  }
  return melhor;
}

const destino = process.argv[3] ?? join(raiz, 'saida/legendas', formato);
mkdirSync(destino, { recursive: true });

for (const [lang, falas] of Object.entries(bloco.falas)) {
  let de = 0;
  let vtt = 'WEBVTT\n';
  bloco.cenas.forEach((id, i) => {
    const arquivo = `voz/${formato}-${lang}-${String(i + 1).padStart(2, '0')}.mp3`;
    const fala = manifesto[arquivo]?.duracao ?? 3;
    const quadros = Math.round(Math.max(MINIMO, ANTES + fala + DEPOIS + (bloco.extra[id] ?? 0)) * FPS);
    const inicio = de / FPS + Math.round(ANTES * FPS) / FPS;
    const partes = pedacos(falas[i] ?? '');
    const total = partes.reduce((s, p) => s + p.length, 0);
    let t = inicio;
    for (const parte of partes) {
      const dura = (fala * parte.length) / total;
      vtt += `\n${tempo(t)} --> ${tempo(t + dura)}\n${linhas(parte)}\n`;
      t += dura;
    }
    de += quadros;
  });
  writeFileSync(join(destino, `legendas-${lang}.vtt`), vtt);
  console.log(`legendas-${lang}.vtt: ${tempo(de / FPS)}`);
}
