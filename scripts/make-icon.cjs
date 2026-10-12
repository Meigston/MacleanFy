/*
 * Gera o ícone do app a partir do símbolo da marca.
 *
 *   pnpm icon
 *
 * Desenha o símbolo sobre a placa arredondada que o macOS espera (824px num
 * quadro de 1024px), salva build/icon.png e monta build/icon.icns com as
 * ferramentas do próprio sistema (sips e iconutil).
 */
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Embutido na página: um documento data: não pode carregar arquivos locais.
const symbol = `data:image/png;base64,${fs.readFileSync(path.join(root, 'src/renderer/src/assets/symbol.png')).toString('base64')}`;
const buildDir = path.join(root, 'build');
const iconset = path.join(buildDir, 'icon.iconset');

const html = `<!doctype html>
<style>
  html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; }
  .plate {
    position: absolute; left: 100px; top: 100px; width: 824px; height: 824px;
    border-radius: 185px; overflow: hidden;
    background:
      radial-gradient(circle at 50% 44%, #1a16a0 0%, #0c0862 38%, #05001d 100%);
    box-shadow: inset 0 0 0 3px rgba(125, 246, 255, 0.28), inset 0 0 90px rgba(19, 250, 254, 0.14);
  }
  img {
    position: absolute; left: 97px; top: 97px; width: 630px; height: 630px;
    mix-blend-mode: screen;
    -webkit-mask-image: radial-gradient(closest-side, #000 72%, transparent 100%);
  }
</style>
<div class="plate"><img src="${symbol}"></div>`;

// O cache do Electron vai para a pasta temporária do sistema, não para ~/Library/Application Support.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'macleanfy-icon-')));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await win.webContents.executeJavaScript('document.querySelector("img").decode()');
  await new Promise((resolve) => setTimeout(resolve, 300));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(iconset, { recursive: true });
  const master = path.join(buildDir, 'icon.png');
  fs.writeFileSync(master, image.resize({ width: 1024, height: 1024 }).toPNG());

  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      const px = String(size * scale);
      execFileSync('/usr/bin/sips', ['-z', px, px, master, '--out', path.join(iconset, name)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  fs.rmSync(iconset, { recursive: true, force: true });

  console.log('build/icon.png e build/icon.icns gerados');
  app.quit();
});
