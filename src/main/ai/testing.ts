import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AI_COLD_DAYS } from '../../shared/api';
import { duSize, isInUse } from './context';
import { measure } from './measure';
import type { AiContext, ExecResult, ProcessInfo } from './types';

/** Ferramenta dos testes dos coletores: nunca é importada pelo app. */

export const DAY = 24 * 60 * 60 * 1000;
/** O "agora" dos testes: 29/10/2026, meio-dia UTC. */
export const NOW = Date.UTC(2026, 9, 29, 12);

/** Uma conta de mentira numa pasta temporária, com `home` e `tmp` próprios. */
export async function sandbox(): Promise<{ root: string; home: string; tmp: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'macleanfy-ai-'));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  await mkdir(home, { recursive: true });
  await mkdir(tmp, { recursive: true });
  return { root, home, tmp, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Escreve um arquivo (criando as pastas) com o mtime de `daysAgo` dias antes de NOW. */
export async function put(path: string, content: string | number = 1024, daysAgo = 0): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === 'number' ? Buffer.alloc(content, 1) : content);
  await age(path, daysAgo);
  return path;
}

export async function age(path: string, daysAgo: number): Promise<void> {
  const when = new Date(NOW - daysAgo * DAY);
  await utimes(path, when, when);
}

export interface FakeOptions {
  home: string;
  tmp: string;
  processes?: ProcessInfo[];
  projects?: string[];
  claudeSessions?: AiContext['claudeSessions'];
  env?: Record<string, string | undefined>;
  /** Responde às chamadas de `exec`; sem ela, todo comando sai com código 127. */
  exec?: (file: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult> | ExecResult;
}

/** Um AiContext que só enxerga a conta de mentira; `trashed` guarda o que foi para a Lixeira. */
export function fakeContext(options: FakeOptions): AiContext & { trashed: string[] } {
  const processes = options.processes ?? [];
  const trashed: string[] = [];
  return {
    home: options.home,
    tmp: options.tmp,
    uid: 501,
    now: NOW,
    env: options.env ?? {},
    processes,
    claudeSessions: options.claudeSessions ?? [],
    projects: options.projects ?? [],
    isCold: (ms) => ms <= 0 || NOW - ms > AI_COLD_DAYS * DAY,
    inUse: (path) => isInUse(processes, path),
    running: (exe) => processes.some((p) => exe.test(p.exe)),
    measure,
    du: duSize,
    exec: async (file, args, execOptions) =>
      options.exec ? options.exec(file, args, execOptions) : { code: 127, stdout: '', stderr: 'not faked' },
    trash: async (path) => {
      trashed.push(path);
      await rm(path, { recursive: true, force: true });
    },
    trashed,
  };
}
