import type { StartupScope } from '../shared/api';
import type { PlistReading } from './startup';

/**
 * O que um app deixa fora da conta de quem usa o Mac: os plists do launchd em
 * /Library e os ajudantes privilegiados que eles rodam. Só o root os apaga, e é
 * isso que sobra quebrado quando o app vai para a Lixeira sozinho.
 */

const SYSTEM_FOLDERS = ['/Library/LaunchAgents', '/Library/LaunchDaemons', '/Library/PrivilegedHelperTools'];
const HELPERS = '/Library/PrivilegedHelperTools/';

/** Letras, números, ponto, hífen e sublinhado, começando por letra ou número: nada que o shell interprete. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SystemFile {
  path: string;
  /** Rótulo do job, para tirá-lo do launchd antes de apagar o plist; nulo para o ajudante. */
  label: string | null;
  scope: 'agent' | 'daemon' | 'helper';
}

/** Direto numa das três pastas, com um nome que dispensa aspas. */
export function isSafeSystemPath(path: string): boolean {
  const slash = path.lastIndexOf('/');
  return SYSTEM_FOLDERS.includes(path.slice(0, slash)) && SAFE_NAME.test(path.slice(slash + 1));
}

/**
 * Os jobs de /Library que são do app: o programa mora dentro do pacote dele, ou o
 * plist o declara dono em AssociatedBundleIdentifiers. O ajudante privilegiado que
 * o job roda vai junto.
 */
export function systemFilesOf(
  app: { path: string; bundleId: string | null },
  plists: Array<{ scope: StartupScope; path: string; reading: PlistReading }>
): SystemFile[] {
  const files = new Map<string, SystemFile>();
  for (const { scope, path, reading } of plists) {
    if (scope === 'user') continue;
    const inside = !!reading.program?.startsWith(app.path + '/');
    const declared = !!app.bundleId && (reading.bundleIds ?? []).includes(app.bundleId);
    if (!inside && !declared) continue;
    if (!reading.label || !SAFE_NAME.test(reading.label) || !isSafeSystemPath(path)) continue;

    files.set(path, { path, label: reading.label, scope });
    const program = reading.program;
    if (program?.startsWith(HELPERS) && isSafeSystemPath(program)) {
      files.set(program, { path: program, label: null, scope: 'helper' });
    }
  }
  return [...files.values()];
}

/**
 * Tira cada job do launchd e apaga os arquivos, num comando só — uma senha para
 * tudo. Só entra o que passou por `isSafeSystemPath`, então não há aspas nem
 * espaços a escapar dentro do `do shell script`.
 */
export function removalScript(files: SystemFile[], uid: number): string {
  if (!Number.isInteger(uid) || uid < 0) return '';
  const steps: string[] = [];
  for (const file of files) {
    if (!isSafeSystemPath(file.path)) continue;
    if (file.label && SAFE_NAME.test(file.label) && file.scope !== 'helper') {
      const domain = file.scope === 'daemon' ? 'system' : `gui/${uid}`;
      steps.push(`/bin/launchctl bootout ${domain}/${file.label} 2>/dev/null || true`);
    }
    steps.push(`/bin/rm -f ${file.path}`);
  }
  return steps.join('; ');
}
