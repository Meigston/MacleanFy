/*
 * Monta o site estático de macleanfy.com em site/dist.
 *
 *   node site/build.mjs
 *
 * Sai uma página por idioma (/ e /en), do mesmo modelo e dos textos em site/strings.
 * A versão, os códigos Pix, o link do Stripe e os QR codes vêm do próprio repositório:
 * o site não guarda cópia do que o app já define. Não usa nenhuma dependência.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');
const dist = join(site, 'dist');

const ORIGIN = 'https://macleanfy.com';
const REPO = 'https://github.com/Meigston/MacleanFy';
const LOCALES = [
  { id: 'pt', lang: 'pt-BR', path: '/', file: 'index.html' },
  { id: 'en', lang: 'en', path: '/en', file: 'en/index.html' },
];

const read = (path) => readFile(path, 'utf8');
const json = async (path) => JSON.parse(await read(path));
const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Campos de um código Pix "copia e cola": dois dígitos de id, dois de tamanho, o valor. */
function parsePix(payload) {
  const fields = {};
  for (let at = 0; at + 4 <= payload.length; ) {
    const length = Number(payload.slice(at + 2, at + 4));
    fields[payload.slice(at, at + 2)] = payload.slice(at + 4, at + 4 + length);
    at += 4 + length;
  }
  return fields;
}

const pkg = await json(join(root, 'package.json'));
const support = await json(join(root, 'src/shared/support.json'));
const template = await read(join(site, 'template.html'));
const strings = Object.fromEntries(
  await Promise.all(LOCALES.map(async ({ id }) => [id, await json(join(site, 'strings', `${id}.json`))]))
);

// Um texto sem tradução quebra a montagem, em vez de sair em branco na página.
const keys = Object.keys(strings.pt);
for (const { id } of LOCALES) {
  const missing = keys.filter((key) => !(key in strings[id]));
  const extra = Object.keys(strings[id]).filter((key) => !keys.includes(key));
  if (missing.length || extra.length) {
    throw new Error(`strings/${id}.json: faltam [${missing}] e sobram [${extra}]`);
  }
}

const fixed = parsePix(support.pix.fixed);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(site, 'assets'), join(dist, 'assets'), { recursive: true });
for (const option of Object.keys(support.pix)) {
  await cp(join(root, 'assets/support', `pix-qr-${option}.svg`), join(dist, 'assets', `pix-qr-${option}.svg`));
}

for (const locale of LOCALES) {
  const other = LOCALES.find((candidate) => candidate !== locale);
  const values = {
    ...strings[locale.id],
    lang: locale.lang,
    canonical: ORIGIN + (locale.path === '/' ? '/' : locale.path),
    'alternate.pt': `${ORIGIN}/`,
    'alternate.en': `${ORIGIN}/en`,
    'home.path': locale.path,
    'other.path': other.path,
    version: pkg.version,
    origin: ORIGIN,
    repo: REPO,
    'download.arm64': `${REPO}/releases/latest/download/MacleanFy-arm64.dmg`,
    'download.x64': `${REPO}/releases/latest/download/MacleanFy-x64.dmg`,
    'pix.fixed.code': support.pix.fixed,
    'pix.open.code': support.pix.open,
    'pix.fixed.amount': new Intl.NumberFormat(locale.lang, { style: 'currency', currency: 'BRL' }).format(
      Number(fixed['54'])
    ),
    'pix.recipient': fixed['59'],
    stripe: support.stripe,
  };

  const html = template.replace(/\{\{([\w.]+)\}\}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`template.html usa {{${key}}}, que não existe`);
    return escapeHtml(values[key]);
  });

  const file = join(dist, locale.file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  console.log(`site/dist/${locale.file}`);
}
