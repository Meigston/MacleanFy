import { analisarAntes } from './_comum.mjs';
// Rota: smart, já analisada. Só o seguro marcado → Limpar → confirmação → espaço liberado.
export default async (r) => {
  await analisarAntes(r);
  await r.wait(300);
  await r.start();
  await r.wait(1300);
  await r.move({ sel: '.cat[data-category="temp-files"] .badge' }, 900);
  r.mark('seguro');
  await r.wait(900);
  await r.click('[data-action="clean"]', 1000);
  r.mark('dialogo');
  await r.wait(900);
  await r.move({ sel: '.modal .option', dx: 0.25 }, 700);
  r.mark('simular');
  await r.wait(1000);
  await r.click('[data-action="confirm-clean"]', 800);
  r.mark('limpando');
  await r.waitFor('.result__icon svg.lucide-circle-check, .modal .result .lucide-circle-check');
  r.mark('limpo');
  await r.wait(2400);
};
