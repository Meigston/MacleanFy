// Rota: performance. Diagnóstico, métricas ao vivo, apps por memória e itens em segundo plano.
export default async (r) => {
  await r.waitFor('.perf__diagnosis');
  await r.wait(2200);
  await r.start();
  await r.wait(1500);
  await r.move({ sel: '.finding', dx: 0.3 }, 900);
  r.mark('diagnostico');
  await r.wait(1600);
  await r.move({ x: 640, y: 480 }, 500);
  await r.scroll('.page__body', 330, 1700);
  r.mark('metricas');
  await r.wait(2200);
  await r.click('.segmented__option:nth-child(2)', 900);
  r.mark('memoria');
  await r.wait(1800);
  await r.scroll('.page__body', 520, 1800);
  r.mark('segundo-plano');
  await r.wait(2400);
};
