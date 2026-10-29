import { T, ocioso } from './_comum.mjs';
// Rota: overview. A análise começa na própria Visão geral e os cartões se enchem.
export default async (r) => {
  await r.waitFor('[data-action="scan"]');
  await r.wait(500);
  await r.start();
  await r.wait(1400);
  await r.click('[data-action="scan"]', 900);
  r.mark('analise');
  await ocioso(r);
  r.mark('pronto');
  await r.wait(600);
  await r.move({ sel: '.card', text: T(r, 'Espaço recuperável', 'Reclaimable space'), dx: 0.35, dy: 0.45 }, 1000);
  await r.wait(1400);
  await r.move({ sel: '.card', text: T(r, 'Já liberado', 'Freed so far'), dx: 0.4, dy: 0.4 }, 900);
  await r.wait(2200);
};
