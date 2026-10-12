/*
 * Empacotamento do MacleanFy.
 *
 *   pnpm dist      gera dist/MacleanFy-arm64.dmg e dist/MacleanFy-x64.dmg
 *
 * Sem variáveis de ambiente o app sai com assinatura ad-hoc: qualquer pessoa compila e
 * roda o que compilou. O instalador que vai a público precisa de um certificado
 * "Developer ID Application" (CSC_NAME, ou CSC_LINK no CI) e de notarização — o
 * electron-builder notariza o app sozinho quando encontra as credenciais da Apple no
 * ambiente, e o gancho no fim deste arquivo faz o mesmo com o .dmg. O README traz as
 * variáveis.
 */
const { execFileSync } = require('node:child_process');

const developerId = Boolean(process.env.CSC_NAME || process.env.CSC_LINK);

/** Credenciais para o notarytool, lidas das mesmas variáveis que o electron-builder usa. */
function notaryCredentials() {
  const env = process.env;
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (env.APPLE_KEYCHAIN_PROFILE) return ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  }
  return null;
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.macleanfy.app',
  productName: 'MacleanFy',
  copyright: 'Copyright © 2026 Meigston Ramos',

  directories: {
    output: 'dist',
    buildResources: 'build',
  },

  // O app inteiro já está empacotado em out/ pelo electron-vite; nada vem de node_modules.
  files: ['out/**', 'package.json', 'LICENSE', 'NOTICE.md', 'licenses/**'],

  // Só os idiomas que a interface tem; o Electron traz dezenas.
  electronLanguages: ['en', 'pt_BR'],

  mac: {
    category: 'public.app-category.utilities',
    icon: 'build/icon.icns',
    // Um instalador por arquitetura: o universal dobraria o tamanho de um app cuja
    // razão de existir é liberar espaço.
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    // Sem a versão no nome, o link "releases/latest/download/..." do README vale para sempre.
    artifactName: '${productName}-${arch}.${ext}',
    // "-" é assinatura ad-hoc. Com Developer ID a chave fica de fora para o
    // electron-builder procurar o certificado no Keychain.
    ...(developerId ? {} : { identity: '-' }),
    // O hardened runtime é exigido pela notarização, e com assinatura ad-hoc impede o app de abrir.
    hardenedRuntime: developerId,
    extendInfo: {
      LSMinimumSystemVersion: '12.0',
      NSHumanReadableCopyright: 'Copyright © 2026 Meigston Ramos. Baseado no mac-cleaner-cli (MIT).',
    },
  },

  dmg: {
    title: '${productName} ${version}',
    // O fundo (build/background.png e @2x) dá o tamanho da janela: 660 × 400.
    // As posições têm de bater com scripts/make-dmg-background.cjs.
    iconSize: 104,
    iconTextSize: 13,
    contents: [
      { x: 180, y: 190 },
      { x: 480, y: 190, type: 'link', path: '/Applications' },
    ],
    // Sem atualização automática, o .blockmap não tem quem o leia.
    writeUpdateInfo: false,
  },

  // O electron-builder assina e notariza o app, mas o .dmg que o embrulha sai sem
  // assinatura. É o .dmg que a pessoa baixa, então ele também é assinado, notarizado e
  // recebe o tíquete grampeado, para o macOS conferir mesmo sem internet. Só com CSC_NAME,
  // que é quem diz o nome do certificado a usar.
  afterAllArtifactBuild: async ({ artifactPaths }) => {
    const credentials = notaryCredentials();
    if (!process.env.CSC_NAME || !credentials) return [];

    const identity = `Developer ID Application: ${process.env.CSC_NAME.replace(/^Developer ID Application: /, '')}`;
    for (const dmg of artifactPaths.filter((file) => file.endsWith('.dmg'))) {
      execFileSync('codesign', ['--force', '--timestamp', '--sign', identity, dmg], { stdio: 'inherit' });
      execFileSync('xcrun', ['notarytool', 'submit', dmg, ...credentials, '--wait'], { stdio: 'inherit' });
      // Se a Apple recusar, é aqui que o build para: sem tíquete não há o que grampear.
      execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    }
    return [];
  },
};
