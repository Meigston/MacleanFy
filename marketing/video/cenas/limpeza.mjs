import { ocioso } from './_comum.mjs';
// Rota: smart. Analisar, as 17 categorias chegando, rolar e abrir uma categoria.
export default async (r) => {
  await r.waitFor('[data-action="scan"]');
  await r.wait(500);
  await r.start();
  await r.wait(1400);
  await r.click('[data-action="scan"]', 900);
  r.mark('analise');
  await ocioso(r);
  r.mark('pronto');
  await r.wait(700);
  await r.move({ x: 640, y: 420 }, 600);
  await r.scroll('.page__body', 430, 1800);
  r.mark('rolou');
  await r.wait(400);
  await r.click({ sel: '.cat[data-category="dev-cache"] .cat__row', dx: 0.35 }, 800);
  r.mark('abriu');
  await r.wait(2400);
};
