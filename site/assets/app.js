// Copia o código Pix do botão e avisa no próprio botão.
for (const button of document.querySelectorAll('[data-copy]')) {
  const label = button.textContent;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = button.dataset.copied;
      setTimeout(() => (button.textContent = label), 2500);
    } catch {
      // Sem acesso à área de transferência, o QR code ao lado continua valendo.
    }
  });
}
