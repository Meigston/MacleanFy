import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { AiBlock, AiToolId } from '../../../shared/api';
import type { AiContext, Collector, Found } from '../types';

/**
 * Temporários e navegadores de automação: Remotion, Chrome headless, Puppeteer e Playwright.
 * Nos temporários a idade não diz nada: as sobras de um render morto têm poucas horas, e a pasta
 * de um render vivo fica minutos parada. O que decide é haver processo vivo dono; sem ele, a
 * sobra é lixo em qualquer idade. As saídas de render, o chrome-headless-shell que o Remotion
 * baixa para o node_modules de cada projeto e os NativeMessagingHosts nunca entram aqui.
 */

/** Parado há menos disso, um temporário pode ser de um render ou navegador que está começando. */
const SETTLE_MS = 60 * 60 * 1000;
/** Pastas medidas ao mesmo tempo: o $TMPDIR chega a ter centenas delas depois de renders mortos. */
const WORKERS = 16;

/** Quem roda o Remotion e o Playwright. Shell e grep citando o nome não são render. */
const RUNTIMES = new Set(['node', 'bun', 'deno', 'npx', 'npm', 'pnpm', 'yarn', 'tsx']);
/** O executável principal de cada navegador baseado no Chromium (os helpers têm outro nome). */
const CHROME = /^(Google Chrome( Beta| Dev| Canary| for Testing)?|Chromium|chrome-headless-shell|headless_shell)$/;
/** Os que caem num perfil descartável `<pasta padrão>-headless` quando chamados sem --user-data-dir. */
const HEADLESS_PRODUCTS = ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Google/Chrome for Testing', 'Chromium'];

/** Pastas que o macOS só deixa ler com autorização: abrir uma delas mostra o pedido na tela. */
const PROTECTED = [
  'Documents',
  'Desktop',
  'Downloads',
  'Library/Mobile Documents',
  'Library/CloudStorage',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
];

/** Uma sobra: uma pasta, ou o perfil e o cache de mesmo nome do Chrome headless. */
interface Leftover {
  paths: string[];
  size: number;
  /** O mais novo entre os arquivos e a própria pasta. */
  newest: number;
  /** Um processo vivo pode estar usando. */
  held: boolean;
}

type Recheck = (ctx: AiContext, paths: string[]) => Promise<AiBlock | null>;

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

const subdirs = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);

async function mapLimit<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, worker));
  return results;
}

/** O $TMPDIR aparece como /var/folders ou /private/var/folders, conforme quem resolveu o caminho. */
function aliases(path: string): string[] {
  if (path.startsWith('/private/var/')) return [path, path.slice('/private'.length)];
  if (path.startsWith('/var/')) return [path, `/private${path}`];
  return [path];
}

const busy = (ctx: AiContext, paths: readonly string[]) => paths.some((path) => aliases(path).some((alias) => ctx.inUse(alias)));

/**
 * O SingletonLock do perfil aponta para `host-PID`. Vale o PID vivo e sendo de um Chrome (PID morto
 * é reaproveitado), e não o host: o nome Bonjour do Mac muda de sufixo.
 */
async function lockedByChrome(ctx: AiContext, profile: string): Promise<boolean> {
  const target = await readlink(join(profile, 'SingletonLock')).catch(() => '');
  const pid = Number(/-(\d+)$/.exec(target)?.[1] ?? 0);
  const owner = pid > 0 ? ctx.processes.find((p) => p.pid === pid) : undefined;
  return !!owner && CHROME.test(basename(owner.exe));
}

async function held(ctx: AiContext, paths: readonly string[]): Promise<boolean> {
  if (busy(ctx, paths)) return true;
  return (await Promise.all(paths.map((path) => lockedByChrome(ctx, path)))).some(Boolean);
}

/** Render do Remotion vivo: o CLI ou o Studio no Node, o compositor, o navegador dele. */
function remotionAlive(ctx: AiContext): boolean {
  return ctx.processes.some((p) => {
    const exe = basename(p.exe);
    if (exe === 'remotion' || exe === 'chrome-headless-shell' || p.exe.includes('/@remotion/')) return true;
    if (RUNTIMES.has(exe) && /(^|[\s/@])remotion\b/.test(p.args)) return true;
    // Com --browser-executable, o render abre o Chrome do sistema num perfil temporário do Puppeteer.
    return CHROME.test(exe) && p.args.includes('puppeteer_dev_chrome_profile-');
  });
}

/**
 * Chrome principal com --headless e sem --user-data-dir: é ele que cria os scoped_dir, sem dizer
 * qual. Os helpers não recebem a pasta, então enquanto ele roda nenhum scoped_dir sai.
 */
function headlessAlive(ctx: AiContext): boolean {
  return ctx.processes.some(
    (p) =>
      CHROME.test(basename(p.exe)) &&
      /(^|\s)--headless(=|\s|$)/.test(p.args) &&
      !/(^|\s)--type=/.test(p.args) &&
      !/(^|\s)--user-data-dir[=\s]/.test(p.args)
  );
}

function playwrightAlive(ctx: AiContext, browsers: string | null): boolean {
  return ctx.processes.some(
    (p) => (RUNTIMES.has(basename(p.exe)) && /(^|[\s/@])playwright\b/.test(p.args)) || (!!browsers && inside(p.exe, browsers))
  );
}

async function measureAll(ctx: AiContext, paths: readonly string[]): Promise<{ size: number; newest: number }> {
  let size = 0;
  let newest = 0;
  for (const path of paths) {
    const [measured, own] = await Promise.all([ctx.measure(path), lstat(path).catch(() => null)]);
    size += measured.size;
    // A pasta conta também: um render que acabou de criá-la ainda não escreveu arquivo nenhum.
    newest = Math.max(newest, measured.newest, own?.mtimeMs ?? 0);
  }
  return { size, newest };
}

/** As pastas do $TMPDIR agrupadas pelo nome que cada padrão captura, sem a parte aleatória. */
async function tmpGroups(ctx: AiContext, patterns: readonly RegExp[]): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  for (const name of await subdirs(ctx.tmp)) {
    const label = patterns.map((pattern) => pattern.exec(name)?.[1]).find(Boolean);
    if (label) groups.set(label, [...(groups.get(label) ?? []), join(ctx.tmp, name)]);
  }
  return groups;
}

async function leftovers(ctx: AiContext, paths: readonly string[], isHeld: (path: string) => Promise<boolean> | boolean): Promise<Leftover[]> {
  return mapLimit(paths, async (path) => ({ ...(await measureAll(ctx, [path])), paths: [path], held: await isHeld(path) }));
}

function row(tool: AiToolId, label: string, safety: Found['safety'], members: Leftover[]): Found {
  const newest = members.reduce((a, b) => (b.newest > a.newest ? b : a));
  return {
    tool,
    kind: 'temp',
    label,
    project: null,
    path: newest.paths[0],
    paths: members.flatMap((member) => member.paths),
    size: members.reduce((sum, member) => sum + member.size, 0),
    count: members.length,
    lastUsed: newest.newest,
    safety,
    removal: 'trash',
  };
}

/**
 * Uma linha para as sobras sem dono, lixo em qualquer idade, e outra para as que um processo
 * ainda pode estar usando. São centenas de pastas: uma linha para cada não caberia na tela.
 */
function rows(ctx: AiContext, tool: AiToolId, label: string, safety: Found['safety'], members: Leftover[], recheck: Recheck): Found[] {
  const orphans = members.filter((member) => !member.held && ctx.now - member.newest > SETTLE_MS);
  const live = members.filter((member) => !orphans.includes(member));
  const found: Found[] = [];
  if (orphans.length > 0) {
    const item = row(tool, label, safety, orphans);
    const paths = item.paths ?? [item.path];
    found.push({ ...item, key: 'orphan', junk: 'orphan', recheck: (fresh) => recheck(fresh, paths) });
  }
  // Sem processo dono e mexida há menos de uma hora, a pasta pode ser de algo que acabou de começar.
  if (live.length > 0) {
    found.push({ ...row(tool, label, safety, live), key: 'live', blocked: live.some((member) => member.held) ? 'in-use' : 'recent' });
  }
  return found.filter((item) => item.size > 0);
}

const remotion: Collector = {
  id: 'remotion',
  async collect(ctx) {
    const alive = remotionAlive(ctx);
    const found: Found[] = [];
    // Área de assets de cada render e pasta de trabalho do renderMedia: ficam quando o processo morre.
    for (const [label, paths] of await tmpGroups(ctx, [/^(remotion-v.+-assets)/, /^(react-motion-render)/])) {
      const members = await leftovers(ctx, paths, (path) => alive || busy(ctx, [path]));
      found.push(...rows(ctx, 'remotion', label, 'safe', members, async (fresh, all) => (remotionAlive(fresh) || busy(fresh, all) ? 'in-use' : null)));
    }
    return found;
  },
};

const chromeHeadless: Collector = {
  id: 'chrome-headless',
  async collect(ctx) {
    const found: Found[] = [];
    const headless = headlessAlive(ctx);

    for (const product of HEADLESS_PRODUCTS) {
      // O perfil fica em Application Support e o cache dele no espelho em Caches, com o mesmo nome.
      // O Chrome apaga o perfil ao sair limpo, mas nunca o cache: cache sem par é de Chrome que já saiu.
      const profiles = join(ctx.home, 'Library/Application Support', `${product}-headless`);
      const caches = join(ctx.home, 'Library/Caches', `${product}-headless`);
      const [inProfiles, inCaches] = (await Promise.all([subdirs(profiles), subdirs(caches)])).map(
        (names) => new Set(names.filter((name) => name.startsWith('scoped_dir')))
      );
      const members = await mapLimit([...new Set([...inProfiles, ...inCaches])], async (name) => {
        const paths = [...(inProfiles.has(name) ? [join(profiles, name)] : []), ...(inCaches.has(name) ? [join(caches, name)] : [])];
        return { ...(await measureAll(ctx, paths)), paths, held: headless || (await held(ctx, paths)) };
      });
      found.push(
        ...rows(ctx, 'chrome-headless', basename(profiles), 'safe', members, async (fresh, paths) =>
          headlessAlive(fresh) || (await held(fresh, paths)) ? 'in-use' : null
        )
      );
    }

    // Perfis temporários do Puppeteer (e do Remotion, que usa o mesmo prefixo) e do Playwright.
    // Esses passam --user-data-dir, então o processo dono cita a pasta.
    for (const [label, paths] of await tmpGroups(ctx, [/^(puppeteer_dev_chrome_profile)-/, /^(playwright_[a-z]+dev_profile)-/])) {
      const members = await leftovers(ctx, paths, (path) => held(ctx, [path]));
      found.push(...rows(ctx, 'chrome-headless', label, 'safe', members, async (fresh, all) => ((await held(fresh, all)) ? 'in-use' : null)));
    }
    return found;
  },
};

/** Caminho que dá para ler sem o macOS pedir autorização na tela: projeto conhecido sim, Documentos não. */
function readable(ctx: AiContext, path: string): boolean {
  if (ctx.projects.some((project) => inside(path, project))) return true;
  if (inside(path, '/Volumes')) return false;
  return !PROTECTED.some((dir) => inside(path, join(ctx.home, dir)));
}

/**
 * A pasta que uma variável de ambiente aponta: `undefined` sem a variável, nulo quando ela não
 * serve (relativa, ou fora da conta, onde a última trava antes da Lixeira recusaria tudo).
 */
function envDir(ctx: AiContext, name: string): string | null | undefined {
  const value = ctx.env[name];
  if (!value) return undefined;
  const dir = isAbsolute(value) ? resolve(value) : '';
  return dir && dir !== ctx.home && inside(dir, ctx.home) ? dir : null;
}

/** No Mac os navegadores ficam em ~/Library/Caches/ms-playwright; com a variável em 0, no node_modules de cada projeto. */
function playwrightDir(ctx: AiContext): string | null {
  if (ctx.env.PLAYWRIGHT_BROWSERS_PATH === '0') return null;
  const custom = envDir(ctx, 'PLAYWRIGHT_BROWSERS_PATH');
  return custom === undefined ? join(ctx.home, 'Library/Caches/ms-playwright') : custom;
}

interface BrowsersJson {
  browsers?: Array<{ name?: unknown; revision?: unknown; revisionOverrides?: Record<string, unknown> }>;
}

/**
 * As revisões que alguma instalação do Playwright ainda usa. Cada arquivo em .links guarda a pasta
 * de um playwright-core, e o browsers.json dele diz as revisões: é o que o próprio Playwright
 * consulta antes de apagar navegador. Nulo quando uma instalação está numa pasta que pediria
 * autorização para ler: aí não dá para dizer que nada usa uma revisão velha.
 */
async function linkedRevisions(ctx: AiContext, root: string): Promise<Set<string> | null> {
  const used = new Set<string>();
  const dirName = (name: string, revision: unknown) => `${name.replace(/-/g, '_')}-${String(revision)}`;
  for (const link of await readdir(join(root, '.links')).catch(() => [])) {
    const target = (await readFile(join(root, '.links', link), 'utf8').catch(() => '')).trim();
    if (!isAbsolute(target)) continue;
    if (!readable(ctx, target)) return null;
    // Instalação apagada ou browsers.json estragado: o próprio Playwright descarta esse link.
    let parsed: BrowsersJson;
    try {
      parsed = JSON.parse(await readFile(join(target, 'browsers.json'), 'utf8')) as BrowsersJson;
    } catch {
      continue;
    }
    for (const browser of Array.isArray(parsed.browsers) ? parsed.browsers : []) {
      if (typeof browser.name !== 'string' || browser.revision === undefined) continue;
      used.add(dirName(browser.name, browser.revision));
      // Revisão própria de uma versão do macOS: pasta `<nome>_<plataforma>_special-<revisão>`.
      for (const [platform, revision] of Object.entries(browser.revisionOverrides ?? {})) {
        used.add(dirName(`${browser.name}_${platform}_special`, revision));
      }
    }
  }
  return used;
}

async function runtime(ctx: AiContext, tool: AiToolId, path: string, label: string, old: boolean): Promise<Found | null> {
  const { size, newest } = await ctx.measure(path);
  if (size <= 0) return null;
  return {
    tool,
    kind: 'runtime',
    label,
    project: null,
    path,
    size,
    count: 1,
    // Nenhum dos dois grava quando o navegador rodou: o arquivo mais novo é a data do download.
    lastUsed: newest,
    confidence: 'low',
    safety: 'moderate',
    removal: 'trash',
    hint: 'redownload',
    ...(old ? { junk: 'old-version' as const } : {}),
  };
}

const playwright: Collector = {
  id: 'playwright',
  async collect(ctx) {
    const found: Found[] = [];
    const root = playwrightDir(ctx);

    if (root) {
      // <navegador>-<revisão>. Os perfis do Playwright MCP (mcp-<canal>-<hash>) guardam logins e ficam de fora.
      const revisions = (await subdirs(root)).flatMap((name) => {
        const match = /^([a-z][a-z0-9_]*)-(\d+)$/.exec(name);
        return match ? [{ name, browser: match[1], revision: Number(match[2]) }] : [];
      });
      const newest = new Map<string, number>();
      for (const { browser, revision } of revisions) newest.set(browser, Math.max(newest.get(browser) ?? 0, revision));
      const used = revisions.length > 0 ? await linkedRevisions(ctx, root) : null;
      const items = await mapLimit(revisions, ({ name, browser, revision }) =>
        runtime(ctx, 'playwright', join(root, name), name, revision < (newest.get(browser) ?? 0) && !!used && !used.has(name))
      );
      found.push(...items.filter((item): item is Found => item !== null));
    }

    // Vídeos, traces e downloads de uma execução, que o Playwright copia para o projeto antes de apagar.
    const alive = playwrightAlive(ctx, root);
    for (const [label, paths] of await tmpGroups(ctx, [/^(playwright-artifacts)-/])) {
      const members = await leftovers(ctx, paths, (path) => alive || busy(ctx, [path]));
      found.push(
        ...rows(ctx, 'playwright', label, 'moderate', members, async (fresh, all) => (playwrightAlive(fresh, root) || busy(fresh, all) ? 'in-use' : null))
      );
    }
    return found;
  },
};

/** Números de uma versão (`131.0.6778.85`, `stable_133.0.3`), para comparar parte a parte. */
const versionParts = (version: string) => version.split(/\D+/).filter(Boolean).map(Number);

function newer(a: string, b: string): boolean {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

const puppeteer: Collector = {
  id: 'puppeteer',
  async collect(ctx) {
    const custom = envDir(ctx, 'PUPPETEER_CACHE_DIR');
    const root = custom === undefined ? join(ctx.home, '.cache/puppeteer') : custom;
    if (!root) return [];

    // <navegador>/<plataforma>-<versão>. A linha separa plataforma e canal (stable_, nightly_ no Firefox).
    const builds: Array<{ path: string; label: string; line: string; version: string }> = [];
    for (const browser of await subdirs(root)) {
      for (const name of await subdirs(join(root, browser))) {
        const match = /^([a-z0-9_]+)-(.+)$/.exec(name);
        if (!match) continue;
        const channel = /^[a-z_]*/.exec(match[2])?.[0] ?? '';
        builds.push({ path: join(root, browser, name), label: `${browser} ${match[2]}`, line: `${browser}/${match[1]}/${channel}`, version: match[2] });
      }
    }
    const latest = new Map<string, string>();
    for (const { line, version } of builds) {
      const current = latest.get(line);
      if (current === undefined || newer(version, current)) latest.set(line, version);
    }
    const items = await mapLimit(builds, ({ path, label, line, version }) => runtime(ctx, 'puppeteer', path, label, latest.get(line) !== version));
    return items.filter((item): item is Found => item !== null);
  },
};

export const automationCollectors: Collector[] = [remotion, chromeHeadless, playwright, puppeteer];
