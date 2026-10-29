import { T } from './_comum.mjs';
// Rota: maintenance. Rodar o Quick Look e o DNS, ligar o .DS_Store.
export default async (r) => {
  await r.waitFor('.task');
  await r.wait(700);
  await r.start();
  await r.wait(1300);
  await r.click({ sel: '.task', text: 'Quick Look', child: '.task__footer .btn' }, 1000);
  r.mark('quicklook');
  await r.wait(2100);
  await r.click({ sel: '.task', text: 'DNS', child: '.task__footer .btn' }, 900);
  r.mark('dns');
  await r.wait(2100);
  await r.move({ x: 640, y: 450 }, 500);
  await r.scroll('.page__body', 400, 1300);
  await r.click({ sel: '.task--setting', child: '.switch' }, 900);
  r.mark('dsstore');
  await r.wait(2200);
  void T;
};
