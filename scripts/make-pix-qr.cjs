/*
 * Gera os QR codes do Pix a partir dos códigos "copia e cola" em src/shared/support.json.
 *
 *   pnpm pix:qr
 *
 * Salva assets/support/pix-qr-<opção>.svg, que o app e o README mostram. Um teste confere
 * que cada arquivo corresponde ao seu código; rode de novo sempre que um código mudar.
 */
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'assets', 'support');

/** Onde fica a imagem de cada opção ("fixed", "open"). */
function qrFile(option) {
  return path.join(dir, `pix-qr-${option}.svg`);
}

/** Preto sobre branco, com a margem de quatro módulos que os leitores pedem. */
function renderPixQr(payload) {
  return QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
}

if (require.main === module) {
  const { pix } = require('../src/shared/support.json');
  fs.mkdirSync(dir, { recursive: true });
  Promise.all(
    Object.entries(pix).map(async ([option, payload]) => {
      fs.writeFileSync(qrFile(option), await renderPixQr(payload));
      console.log(`assets/support/pix-qr-${option}.svg gerado`);
    })
  );
}

module.exports = { renderPixQr, qrFile };
