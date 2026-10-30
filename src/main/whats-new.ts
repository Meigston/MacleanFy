import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * A versão que acabou de ser instalada ou atualizada, na primeira abertura dela, para a
 * interface mostrar as novidades; nas aberturas seguintes, nulo. A última versão aberta
 * fica num arquivo da pasta de dados do app. Sem conseguir gravar, devolve nulo: melhor
 * não mostrar as novidades do que mostrá-las a cada abertura.
 */
export async function firstLaunchOf(version: string, file: string): Promise<string | null> {
  const seen = await readFile(file, 'utf-8').then(
    (text) => text.trim(),
    () => null
  );
  if (seen === version) return null;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, version);
  } catch {
    return null;
  }
  return version;
}
