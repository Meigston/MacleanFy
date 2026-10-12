/*
 * Gera o fundo da janela do instalador (.dmg).
 *
 *   pnpm dmg:background
 *
 * Salva build/background.png e build/background@2x.png; o electron-builder junta os
 * dois num TIFF para telas Retina.
 *
 * Quando a janela tem imagem de fundo, o Finder escreve o nome dos ícones sempre em
 * preto, inclusive no tema escuro (conferido no macOS 26), e não deixa escolher. Num
 * fundo escuro o nome some; por isso cada ícone tem embaixo uma faixa clara de neon,
 * onde o texto preto se lê.
 *
 * As posições abaixo têm de bater com `dmg.contents` em electron-builder.cjs.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WIDTH = 660;
const HEIGHT = 400;
const ICON_SIZE = 104;
const ICON_Y = 190;
const APP_X = 180;
const APPLICATIONS_X = 480;

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
// Embutido na página: um documento data: não pode carregar arquivos locais.
const logo = `data:image/png;base64,${fs.readFileSync(path.join(root, 'assets/brand/logo.png')).toString('base64')}`;

// Centro do nome que o Finder desenha sob um ícone de 104 pt com texto de 13 pt.
const labelY = ICON_Y + ICON_SIZE / 2 + 17;
const arrowFrom = APP_X + ICON_SIZE / 2 + 26;
const arrowTo = APPLICATIONS_X - ICON_SIZE / 2 - 26;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #05001d; }
  .stage {
    position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; zoom: 2;
    font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
    background:
      radial-gradient(60% 55% at 50% 46%, rgba(31, 60, 200, 0.34) 0%, transparent 100%),
      radial-gradient(120% 100% at 50% 0%, #0d0a5e 0%, #090642 42%, #05001d 100%);
  }
  /* A logo vem com o próprio fundo azul-marinho; "screen" o funde com o da janela. */
  .logo {
    position: absolute; left: ${(WIDTH - 310) / 2}px; top: 2px; width: 310px; height: 110px;
    background: url("${logo}") -16px -49px / 332px auto no-repeat;
    mix-blend-mode: screen;
    -webkit-mask-image:
      linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent),
      linear-gradient(180deg, transparent, #000 20%, #000 80%, transparent);
    -webkit-mask-composite: source-in;
  }
  .label {
    position: absolute; top: ${labelY - 13}px; width: 148px; height: 26px; border-radius: 13px;
    filter: blur(2px);
  }
  .label.app { left: ${APP_X - 74}px; background: #2f9dff; box-shadow: 0 0 20px 1px rgba(31, 157, 255, 0.6); }
  .label.applications { left: ${APPLICATIONS_X - 74}px; background: #2fe3ff; box-shadow: 0 0 20px 1px rgba(19, 250, 254, 0.45); }
  svg { position: absolute; left: 0; top: 0; filter: drop-shadow(0 0 5px rgba(19, 250, 254, 0.7)) drop-shadow(0 0 16px rgba(31, 157, 255, 0.55)); }
  .hint { position: absolute; left: 0; right: 0; text-align: center; letter-spacing: 0.1px; }
  .hint.pt { top: 292px; font-size: 14px; font-weight: 500; color: rgba(236, 240, 255, 0.94); }
  .hint.en { top: 314px; font-size: 12px; color: rgba(160, 170, 224, 0.9); }
</style>
<div class="stage">
  <div class="logo"></div>
  <div class="label app"></div>
  <div class="label applications"></div>
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none">
    <defs>
      <linearGradient id="stroke" gradientUnits="userSpaceOnUse" x1="${arrowFrom}" y1="0" x2="${arrowTo}" y2="0">
        <stop offset="0" stop-color="#1f9dff" stop-opacity="0.25"/>
        <stop offset="0.55" stop-color="#1f9dff"/>
        <stop offset="1" stop-color="#13fafe"/>
      </linearGradient>
    </defs>
    <path d="M${arrowFrom} ${ICON_Y}H${arrowTo - 2}M${arrowTo - 13} ${ICON_Y - 11}L${arrowTo} ${ICON_Y}L${arrowTo - 13} ${ICON_Y + 11}"
      stroke="url(#stroke)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <div class="hint pt">Arraste o MacleanFy para a pasta Aplicativos</div>
  <div class="hint en">Drag MacleanFy to the Applications folder</div>
</div>`;

// O cache do Electron vai para a pasta temporária do sistema, não para ~/Library/Application Support.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'macleanfy-dmg-'));
app.setPath('userData', userData);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH * 2,
    height: HEIGHT * 2,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));

  const image = await win.webContents.capturePage();
  const retina = image.resize({ width: WIDTH * 2, height: HEIGHT * 2, quality: 'best' });
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'background@2x.png'), retina.toPNG());
  fs.writeFileSync(path.join(buildDir, 'background.png'), retina.resize({ width: WIDTH, height: HEIGHT, quality: 'best' }).toPNG());

  console.log('build/background.png e build/background@2x.png gerados');
  app.quit();
});

app.on('quit', () => fs.rmSync(userData, { recursive: true, force: true }));
