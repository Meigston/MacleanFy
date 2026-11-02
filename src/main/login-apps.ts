import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import type { LoginAppDTO, LoginAppsDTO, LoginAppsStatus } from '../shared/api';

/**
 * Os apps de "Abrir ao iniciar sessão". O macOS não deixa ler essa lista do disco:
 * só pelo System Events, e só com a permissão de Automação, que ele pede uma vez.
 * Por isso nada aqui roda sozinho antes de a pessoa pedir, e a resposta fica guardada
 * num arquivo da pasta de dados, com os apps que o MacleanFy tirou da lista — eles
 * saem do macOS, e é por esse arquivo que dá para pô-los de volta.
 */

/** A lista inteira em três pedidos ao System Events, não três por app. */
export const LIST_SCRIPT = `
function run() {
  const items = Application('System Events').loginItems;
  const names = items.name();
  const paths = items.path();
  const hidden = items.hidden();
  return JSON.stringify(names.map((name, i) => ({ name, path: paths[i], hidden: hidden[i] })));
}
`;

/** O caminho chega como argumento, nunca dentro do script. */
export const REMOVE_SCRIPT = [
  'on run argv',
  'tell application "System Events" to delete (every login item whose path is (item 1 of argv))',
  'end run',
];

export const ADD_SCRIPT = [
  'on run argv',
  'tell application "System Events" to make new login item at end of login items with properties {path:(item 1 of argv), hidden:((item 2 of argv) is "true")}',
  'end run',
];

/** Enquanto o macOS pergunta, o System Events espera a resposta da pessoa. */
const ASK_TIMEOUT_MS = 3 * 60 * 1000;
const TIMEOUT_MS = 30 * 1000;

export type ScriptResult = { ok: true; stdout: string } | { ok: false; stderr: string };
export type ScriptRunner = (args: string[], timeout: number) => Promise<ScriptResult>;

const runOsascript: ScriptRunner = (args, timeout) =>
  new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => resolve(error ? { ok: false, stderr: String(stderr ?? '') } : { ok: true, stdout })
    );
  });

/** -1743 é o "sem permissão para mandar eventos" do macOS; o resto é falha de quem respondeu. */
export function failureStatus(stderr: string): Extract<LoginAppsStatus, 'denied' | 'error'> {
  return /\(-1743\)/.test(stderr) ? 'denied' : 'error';
}

interface LoginApp {
  name: string;
  path: string;
  hidden: boolean;
}

export function parseLoginItems(output: string): LoginApp[] {
  let list: unknown;
  try {
    list = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.flatMap((entry: Record<string, unknown>) => {
    const path = typeof entry?.path === 'string' ? entry.path.replace(/\/+$/, '') : '';
    if (!path || !isAbsolute(path) || seen.has(path)) return [];
    seen.add(path);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : basename(path).replace(/\.app$/, '');
    return [{ name, path, hidden: entry.hidden === true }];
  });
}

interface State {
  /**
   * O time da assinatura do app quando o macOS deu a permissão. Com o mesmo time, abrir
   * a tela lê a lista sem perguntar nada. Com outro, ou num build sem Developer ID, o
   * macOS pode não reconhecer a resposta e perguntaria de novo: aí a lista espera o clique.
   */
  grantedTo: string | null;
  /** Os que o MacleanFy tirou da lista. */
  off: LoginApp[];
}

export function parseState(text: string | null): State {
  try {
    const state = JSON.parse(text ?? '') as Partial<State>;
    const off = Array.isArray(state.off) ? parseLoginItems(JSON.stringify(state.off)) : [];
    const grantedTo = typeof state.grantedTo === 'string' && state.grantedTo ? state.grantedTo : null;
    return { grantedTo, off };
  } catch {
    return { grantedTo: null, off: [] };
  }
}

/** O time na saída do `codesign -dv`; nulo em assinatura ad-hoc ou sem assinatura. */
export function parseTeamId(output: string): string | null {
  const team = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  return team && team !== 'not set' ? team : null;
}

/** O time que assinou um app. O `codesign -dv` escreve na saída de erro. */
export function signerOf(bundle: string): () => Promise<string | null> {
  let signer: Promise<string | null> | undefined;
  return () =>
    (signer ??= new Promise((resolve) => {
      execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 15000, env: { ...process.env, LC_ALL: 'C' } }, (_error, _stdout, stderr) =>
        resolve(parseTeamId(String(stderr ?? '')))
      );
    }));
}

const exists = (path: string) => access(path).then(
  () => true,
  () => false
);

const byName = (a: LoginAppDTO, b: LoginAppDTO) => a.name.localeCompare(b.name);

export class LoginApps {
  /** O que a última lista mostrou: só esses a interface pode mudar. */
  private known = new Map<string, LoginAppDTO>();
  /** Uma chamada por vez: duas lendo e gravando o arquivo juntas perderiam um app desligado. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly signer: () => Promise<string | null>,
    private readonly osascript: ScriptRunner = runOsascript,
    private readonly isThere: (path: string) => Promise<boolean> = exists
  ) {}

  knows(path: string): boolean {
    return this.known.has(path);
  }

  /**
   * Sem `ask`, só lê se a permissão já foi dada a este mesmo app: abrir a tela nunca
   * faz o macOS perguntar.
   */
  list(ask = false): Promise<LoginAppsDTO> {
    return this.serial(() => this.listNow(ask));
  }

  /** Tira o app da lista ou o põe de volta, e lê a lista de novo para conferir. */
  set(path: string, on: boolean): Promise<{ done: boolean; list: LoginAppsDTO }> {
    return this.serial(() => this.setNow(path, on));
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<State> {
    return parseState(await readFile(this.file, 'utf-8').catch(() => null));
  }

  private async save(state: State): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(state));
    } catch {
      // sem gravar, a próxima abertura só volta a mostrar o botão de pedir
    }
  }

  private async read(timeout: number): Promise<LoginApp[] | LoginAppsStatus> {
    const result = await this.osascript(['-l', 'JavaScript', '-e', LIST_SCRIPT], timeout);
    return result.ok ? parseLoginItems(result.stdout) : failureStatus(result.stderr);
  }

  /** `clicked`: a pessoa acabou de clicar, e o macOS pode perguntar pela permissão. */
  private async listNow(clicked: boolean): Promise<LoginAppsDTO> {
    const [state, signer] = await Promise.all([this.load(), this.signer()]);
    if (!clicked && (!signer || state.grantedTo !== signer)) {
      this.known.clear();
      return { status: 'unasked', apps: [] };
    }
    const read = await this.read(clicked ? ASK_TIMEOUT_MS : TIMEOUT_MS);
    if (typeof read === 'string') {
      this.known.clear();
      // Permissão tirada depois nos Ajustes: a próxima abertura volta a esperar o pedido.
      if (read === 'denied' && state.grantedTo) await this.save({ ...state, grantedTo: null });
      return { status: read, apps: [] };
    }
    const on = new Set(read.map((app) => app.path));
    // Quem continua ou voltou à lista, ou sumiu do disco, deixa de constar como desligado.
    const off = (
      await Promise.all(state.off.map(async (app) => (!on.has(app.path) && (await this.isThere(app.path)) ? app : null)))
    ).filter((app): app is LoginApp => app !== null);
    await this.save({ grantedTo: signer, off });
    const apps = [...read.map((app) => ({ ...app, off: false })), ...off.map((app) => ({ ...app, off: true }))].sort(byName);
    this.known = new Map(apps.map((app) => [app.path, app]));
    return { status: 'granted', apps };
  }

  private async setNow(path: string, on: boolean): Promise<{ done: boolean; list: LoginAppsDTO }> {
    const app = this.known.get(path);
    if (!app) return { done: false, list: await this.listNow(false) };

    if (app.off === on) {
      if (!on) {
        // Anotado antes de sair: se a conferência falhar, o app não se perde. A próxima
        // lista desfaz a anotação se ele continuar lá.
        const state = await this.load();
        const off = state.off.filter((item) => item.path !== app.path);
        await this.save({ ...state, off: [...off, { name: app.name, path: app.path, hidden: app.hidden }] });
      }
      const script = on ? ADD_SCRIPT : REMOVE_SCRIPT;
      const args = [...script.flatMap((line) => ['-e', line]), app.path, ...(on ? [String(app.hidden)] : [])];
      await this.osascript(args, TIMEOUT_MS);
    }
    const list = await this.listNow(true);
    const now = list.apps.find((item) => item.path === app.path);
    return { done: !!now && now.off === !on, list };
  }
}
