/*
 * Empacotamento do MacleanFy.
 *
 *   pnpm dist      gera dist/MacleanFy-<versão>-arm64.dmg e -x64.dmg
 *
 * Sem variáveis de ambiente o app sai com assinatura ad-hoc: qualquer pessoa compila e
 * roda o que compilou. O instalador que vai a público precisa de um certificado
 * "Developer ID Application" (CSC_NAME, ou CSC_LINK no CI) e de notarização — o
 * electron-builder notariza sozinho quando encontra as credenciais da Apple no
 * ambiente. O README traz as variáveis.
 */
const developerId = Boolean(process.env.CSC_NAME || process.env.CSC_LINK);

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.macleanfy.app',
  productName: 'MacleanFy',
  copyright: 'Copyright © 2026 MacleanFy contributors',

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
    artifactName: '${productName}-${version}-${arch}.${ext}',
    // "-" é assinatura ad-hoc. Com Developer ID a chave fica de fora para o
    // electron-builder procurar o certificado no Keychain.
    ...(developerId ? {} : { identity: '-' }),
    // O hardened runtime é exigido pela notarização, e com assinatura ad-hoc impede o app de abrir.
    hardenedRuntime: developerId,
    extendInfo: {
      LSMinimumSystemVersion: '12.0',
      NSHumanReadableCopyright: 'Copyright © 2026 MacleanFy contributors. Baseado no mac-cleaner-cli (MIT).',
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
};
