// Peças comuns dos roteiros de gravação (src/main/record.ts do app).
export const T = (r, pt, en) => (r.lang === 'en' ? en : pt);

/** Espera a interface terminar o que estiver fazendo (o app marca data-busy no <html>). */
export async function ocioso(r, folga = 250) {
  await r.wait(folga);
  for (let i = 0; i < 400; i++) {
    if (await r.eval('document.documentElement.dataset.busy === "0"')) return;
    await r.wait(50);
  }
}

/** Uma análise inteira antes de a gravação começar. */
export async function analisarAntes(r) {
  await r.waitFor('[data-action="scan"]');
  await r.eval('document.querySelector(\'[data-action="scan"]\').click()');
  await ocioso(r, 400);
}
