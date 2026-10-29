// Rota: uninstaller. Abrir o zoom.us, ver o que ele deixou, marcar e mandar para a Lixeira.
export default async (r) => {
  await r.waitFor('.cat__row--app');
  await r.wait(600);
  await r.start();
  await r.wait(1300);
  await r.click({ sel: '.cat__row--app', text: 'zoom.us', dx: 0.4 }, 1000);
  r.mark('aberto');
  await r.wait(800);
  await r.move({ x: 640, y: 430 }, 500);
  await r.scroll('.page__body', 260, 1300);
  await r.wait(900);
  await r.scroll('.page__body', -260, 900);
  await r.click({ sel: '.cat', text: 'zoom.us', child: '.check' }, 800);
  r.mark('marcado');
  await r.wait(600);
  await r.click('.actionbar .btn', 900);
  r.mark('dialogo');
  await r.wait(1000);
  await r.move({ sel: '.modal .notice', dx: 0.3 }, 700);
  await r.wait(900);
  await r.click('.modal .btn--danger', 800);
  r.mark('removendo');
  await r.waitFor('.modal .result');
  r.mark('removido');
  await r.wait(2400);
};
