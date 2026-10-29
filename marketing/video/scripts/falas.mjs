// O texto que vai para o GenerateVoiceover, cena a cena: a fala de roteiro.json
// com as trocas de `pronuncia` do idioma (sigla ou símbolo que a voz lê errado,
// como "CO₂" → "cê ó dois"). A legenda continua com a forma escrita.
// Uso: node scripts/falas.mjs <horizontal|vertical> [idioma]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raiz = new URL('..', import.meta.url).pathname;
const roteiro = JSON.parse(readFileSync(join(raiz, 'roteiro.json'), 'utf8'));
const [formato, so] = process.argv.slice(2);
const bloco = roteiro[formato];
if (!bloco) {
  console.error('uso: node scripts/falas.mjs <horizontal|vertical> [idioma]');
  process.exit(2);
}

for (const [lang, falas] of Object.entries(bloco.falas)) {
  if (so && lang !== so) continue;
  const trocas = Object.entries(roteiro.pronuncia?.[lang] ?? {});
  falas.forEach((fala, i) => {
    const texto = trocas.reduce((t, [de, para]) => t.split(de).join(para), fala);
    console.log(`${formato}-${lang}-${String(i + 1).padStart(2, '0')}\t${texto}`);
  });
}
