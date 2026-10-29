import { ocioso } from './_comum.mjs';
// Rota: disk. Medir, abrir Downloads, mandar o instalador velho do Xcode para a Lixeira.
export default async (r) => {
  await r.waitFor('.disk__intro button');
  await r.wait(400);
  await r.start();
  await r.wait(1300);
  await r.click('.disk__intro button', 900);
  r.mark('medindo');
  await r.waitFor('.disk__list');
  r.mark('medido');
  await r.wait(1500);
  await r.click({ sel: '.disk__row', text: 'Downloads', dx: 0.3 }, 900);
  await ocioso(r, 300);
  r.mark('downloads');
  await r.wait(1000);
  await r.move({ sel: '.disk__row', text: 'Xcode_26.xip', dx: 0.6 }, 800);
  await r.wait(300);
  await r.click({ sel: '.disk__row', text: 'Xcode_26.xip', child: '.disk__trash' }, 600);
  r.mark('dialogo');
  await r.wait(1100);
  await r.click('.modal .btn--danger', 800);
  r.mark('lixeira');
  await r.wait(2600);
};
