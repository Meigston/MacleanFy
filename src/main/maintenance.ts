/**
 * Leituras das tarefas de manutenção. Os comandos rodam em system.ts; aqui fica
 * só o que interpreta a saída deles.
 */

/** As duas chaves que fazem o Finder parar de gravar .DS_Store em rede e em pendrives. */
export const DS_STORE_DOMAIN = 'com.apple.desktopservices';
export const DS_STORE_KEYS = ['DSDontWriteNetworkStores', 'DSDontWriteUSBStores'] as const;

/**
 * Saída do `mdutil -s /`: "Indexing enabled." ou "Indexing disabled." — às vezes
 * "Indexing and searching disabled.". Nulo para o que não der para reconhecer.
 */
export function parseSpotlightStatus(output: string): boolean | null {
  if (/indexing enabled/i.test(output)) return true;
  if (/disabled/i.test(output)) return false;
  return null;
}

/** Um booleano lido pelo `defaults read`, que escreve 1 ou 0. */
export function parseDefaultsBool(output: string): boolean {
  return /^\s*(1|true|yes)\s*$/i.test(output);
}
