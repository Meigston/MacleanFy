/*
 * Gera o QR code do Pix a partir do código "copia e cola" em src/shared/support.json.
 *
 *   pnpm pix:qr
 *
 * Salva assets/support/pix-qr.svg, que o app e o README mostram. Um teste confere que o
 * arquivo corresponde ao código; rode de novo sempre que o código mudar.
 */
const QRCode = require('qrcode');
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'assets', 'support', 'pix-qr.svg');

/** Preto sobre branco, com a margem de quatro módulos que os leitores pedem. */
function renderPixQr(payload) {
  return QRCode.toString(payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
}

if (require.main === module) {
  const { pix } = require('../src/shared/support.json');
  renderPixQr(pix.payload).then((svg) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, svg);
    console.log('assets/support/pix-qr.svg gerado');
  });
}

module.exports = { renderPixQr, file };
