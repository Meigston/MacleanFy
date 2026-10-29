// Mede o que está em public/ (narração, música, gravações) e escreve src/manifesto.json.
// A composição lê as durações daqui: a cena dura o que a narração dela dura.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const raiz = new URL('..', import.meta.url).pathname;
const publico = join(raiz, 'public');

function arquivos(dir) {
  let lista = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) lista = lista.concat(arquivos(caminho));
    else lista.push(caminho);
  }
  return lista;
}

function sonda(caminho) {
  const saida = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type',
    '-of', 'json', caminho
  ]).toString();
  const json = JSON.parse(saida);
  const video = (json.streams || []).find((s) => s.codec_type === 'video');
  return {
    duracao: json.format?.duration ? Number(json.format.duration) : null,
    largura: video?.width ?? null,
    altura: video?.height ?? null
  };
}

const manifesto = {};
for (const caminho of arquivos(publico)) {
  if (!/\.(mp3|wav|mp4|mov|png|jpg)$/i.test(caminho)) continue;
  const chave = relative(publico, caminho);
  manifesto[chave] = sonda(caminho);
}
writeFileSync(join(raiz, 'src/manifesto.json'), JSON.stringify(manifesto, null, 1));
console.log(`${Object.keys(manifesto).length} arquivos medidos`);
