import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DiskEntryDTO, DiskFolderDTO, DiskProgress } from '../shared/api';
import { sizeOnDisk } from '../core/utils/fs';

/**
 * Onde está o espaço da pasta pessoal. Quem mede é o `du`, numa passada só que
 * desce três níveis: a pasta pessoal inteira leva de segundos a poucos minutos,
 * e medir de novo a cada clique seria pagar isso toda vez. Dentro desses três
 * níveis a navegação é instantânea; abaixo deles, mede-se só a subpasta pedida.
 * O mapa vale até o app fechar ou alguém pedir para medir de novo.
 */

/** Níveis que uma passada mede abaixo da pasta pedida. */
const DEPTH = 3;
const PROGRESS_MS = 250;

/** Uma linha do `du -k`: tamanho em blocos de 1 KiB, tab, caminho. */
export function parseDuLine(line: string): { path: string; size: number } | null {
  const match = /^(\d+)\t(\/.*)$/.exec(line);
  return match ? { path: match[2], size: Number(match[1]) * 1024 } : null;
}

const depthOf = (path: string) => (path === '/' ? 0 : path.split('/').length - 1);

export class DiskMap {
  private readonly sizes = new Map<string, number>();
  private readonly children = new Map<string, Set<string>>();
  /** Pastas cuja lista de subpastas está completa. */
  private readonly complete = new Set<string>();
  private scannedAt: number | null = null;
  private running: { root: string; child: ChildProcess; done: Promise<void> } | null = null;

  constructor(
    private readonly home = homedir(),
    private readonly du = '/usr/bin/du'
  ) {}

  /** Só a pasta pessoal e o que está dentro dela; nada de `..` nem caminho relativo. */
  contains(path: string): boolean {
    return resolve(path) === path && (path === this.home || path.startsWith(this.home + '/'));
  }

  /** Acrescenta o que uma passada mediu a partir de `root`. */
  record(root: string, path: string, size: number): void {
    this.sizes.set(path, size);
    if (path !== root) {
      const parent = dirname(path);
      const siblings = this.children.get(parent) ?? new Set<string>();
      siblings.add(path);
      this.children.set(parent, siblings);
    }
    if (depthOf(path) - depthOf(root) < DEPTH) this.complete.add(path);
  }

  /** Esquece uma pasta medida, para a próxima passada não misturar o velho com o novo. */
  private forget(root: string): void {
    for (const map of [this.sizes, this.children]) {
      for (const key of map.keys()) if (key === root || key.startsWith(root + '/')) map.delete(key);
    }
    for (const key of [...this.complete]) if (key === root || key.startsWith(root + '/')) this.complete.delete(key);
  }

  /** Tira um item que foi para a Lixeira e desconta o tamanho dele de cada pasta acima. */
  remove(path: string, size: number): void {
    this.forget(path);
    this.children.get(dirname(path))?.delete(path);
    for (let parent = dirname(path); this.contains(parent); parent = dirname(parent)) {
      const current = this.sizes.get(parent);
      if (current !== undefined) this.sizes.set(parent, Math.max(0, current - size));
      if (parent === this.home) break;
    }
  }

  cancel(): void {
    this.running?.child.kill();
  }

  private scan(root: string, onProgress?: (progress: DiskProgress) => void): Promise<void> {
    // Uma passada que já cobre a pasta pedida serve para os dois.
    if (this.running && (root === this.running.root || root.startsWith(this.running.root + '/'))) return this.running.done;
    this.cancel();
    this.forget(root);

    const child = spawn(this.du, ['-k', '-x', '-d', String(DEPTH), root], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const done = new Promise<void>((resolveDone, reject) => {
      let buffer = '';
      let measured = 0;
      let last = 0;
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const entry = parseDuLine(line);
          if (!entry) continue;
          this.record(root, entry.path, entry.size);
          // O du termina cada pasta antes de passar à próxima: o que ficou pronto no primeiro nível já está medido.
          if (dirname(entry.path) === root) measured += entry.size;
          if (onProgress && Date.now() - last > PROGRESS_MS) {
            last = Date.now();
            onProgress({ bytes: measured, path: entry.path });
          }
        }
      });
      // Pastas sem permissão fazem o du sair com 1, mas o resto da medida vale.
      child.on('close', (_code, signal) => {
        if (this.running?.child === child) this.running = null;
        if (signal) reject(new Error('cancelled'));
        else {
          if (root === this.home) this.scannedAt = Date.now();
          resolveDone();
        }
      });
      child.on('error', reject);
    });
    this.running = { root, child, done };
    return done;
  }

  /**
   * Uma pasta e o que tem dentro, do maior para o menor. Sem `refresh`, só mede o
   * que ainda não foi medido; com `cachedOnly`, não mede nada e devolve nulo se
   * a pasta pessoal ainda não foi medida.
   */
  async list(
    path: string = this.home,
    options: { refresh?: boolean; cachedOnly?: boolean } = {},
    onProgress?: (progress: DiskProgress) => void
  ): Promise<DiskFolderDTO | null> {
    if (!this.contains(path)) throw new Error(`Outside the home folder: ${path}`);
    if (options.cachedOnly && (this.scannedAt === null || !this.complete.has(path))) return null;
    if (options.refresh) await this.scan(this.home, onProgress);
    else if (this.scannedAt === null) await this.scan(this.home, onProgress);
    if (!this.complete.has(path)) await this.scan(path, onProgress);

    const entries: DiskEntryDTO[] = [...(this.children.get(path) ?? [])].map((child) => ({
      name: basename(child),
      path: child,
      size: this.sizes.get(child) ?? 0,
      directory: true,
    }));

    // O du -d só fala de pastas: os arquivos soltos são lidos aqui.
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) continue;
      const stats = await lstat(join(path, entry.name)).catch(() => null);
      if (stats) entries.push({ name: entry.name, path: join(path, entry.name), size: sizeOnDisk(stats), directory: false });
    }
    entries.sort((a, b) => b.size - a.size);

    const crumbs: DiskFolderDTO['crumbs'] = [];
    for (let current = path; ; current = dirname(current)) {
      crumbs.unshift({ name: current === this.home ? '~' : basename(current), path: current });
      if (current === this.home) break;
    }

    const volume = await statfs(this.home);
    return {
      path,
      crumbs,
      size: this.sizes.get(path) ?? entries.reduce((sum, entry) => sum + entry.size, 0),
      entries,
      scannedAt: this.scannedAt ?? Date.now(),
      home: this.sizes.get(this.home) ?? 0,
      disk: { total: volume.blocks * volume.bsize, free: volume.bavail * volume.bsize },
    };
  }

  /**
   * O que pode ir para a Lixeira daqui: algo dentro da pasta pessoal, mas nunca
   * uma pasta do primeiro nível dela nem da Biblioteca — Documentos, Library,
   * Application Support e afins seguram o resto do sistema.
   */
  canTrash(path: string): boolean {
    if (!this.contains(path) || path === this.home) return false;
    const parent = dirname(path);
    return parent !== this.home && parent !== join(this.home, 'Library');
  }
}
