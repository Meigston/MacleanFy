import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AiBlock, AiItemDTO, AiProgress, AiRemoveResultDTO, AiScanDTO } from '../../shared/api';
import { validatePathSafety } from '../../core/utils/fs';
import type { AiContext, Collector, Found } from './types';

/** Coletores lidos ao mesmo tempo: alguns rodam `du` e `git` em dezenas de pastas. */
const CONCURRENCY = 4;

/** Configuração, credencial e índice: nunca saem, venham de qual coletor vierem. */
const NEVER_NAMES = new Set([
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'GEMINI.md',
  '.claude.json',
  'auth.json',
  'config.toml',
  'credentials.json',
  '.credentials.json',
  'mcp.json',
  '.mcp.json',
  'state.vscdb',
  'storage.json',
  'keybindings.json',
  'session_index.jsonl',
  'id_ed25519',
  'token',
  // Claude Code e Claude Desktop.
  'state.json',
  'adopt.json',
  'roster.json',
  'control.key',
  'history.jsonl',
  'sessiondata.img',
  'git-worktrees.json',
  'buddy-tokens.json',
  'ant-did',
  // Gemini, Antigravity e editores da família do VS Code.
  'oauth_creds.json',
  'google_accounts.json',
  'mcp-oauth-tokens.json',
  'trustedFolders.json',
  'installation_id',
  'mcp_config.json',
  '.project_root',
  'extensions.json',
  'argv.json',
]);

/** Bancos de estado do Codex: state_5.sqlite, memories_1.sqlite… */
const NEVER_PATTERN = /^(state|memories|goals|queue|thread_history)_\d+\.sqlite/;

/** Pastas de primeiro nível do Claude Code que guardam configuração ou estado vivo. */
const CLAUDE_KEEP = new Set(['sessions', 'daemon', 'plugins', 'skills', 'agents', 'commands', 'backups', 'memory', 'hooks']);

/** Bloqueios que dizem que o item está em uso agora (ou é a versão em uso): ele é quente, seja qual for a data. */
const LIVE: ReadonlySet<AiBlock> = new Set(['in-use', 'live-session', 'current']);

/**
 * Onde os orquestradores de agentes põem as worktrees. Só os lugares exatos de cada um: uma
 * pasta comum chamada "workspaces" com projetos dentro continua protegida.
 */
const WORKTREE_PLACES = [
  /\/\.claude\/worktrees\/[^/]+$/,
  /\/\.cursor\/worktrees\/.+$/,
  /\/\.codex\/worktrees\/.+$/,
  /\/conductor\/workspaces\/.+$/,
  /\/\.conductor\/[^/]+$/,
  /\/\.claude-squad\/worktrees\/[^/]+$/,
  /\/vibe-kanban\/worktrees\/[^/]+$/,
  /\/\.vibe-kanban-workspaces\/[^/]+$/,
];

export function isWorktreePath(path: string): boolean {
  return WORKTREE_PLACES.some((place) => place.test(path));
}

/** O que denuncia configuração ou dados de app dentro de uma pasta da Biblioteca. */
const CONTAINED_NEVER = new Set([
  'settings.json',
  'keybindings.json',
  'state.vscdb',
  'auth.json',
  'credentials.json',
  '.credentials.json',
  'oauth_creds.json',
  'mcp.json',
  'CLAUDE.md',
  'AGENTS.md',
  'sessiondata.img',
  'id_ed25519',
]);
/**
 * Níveis e entradas que a conferência olha. Vai nível por nível, então User/settings.json (no
 * segundo) é visto antes de qualquer cache gigante do terceiro esgotar a conta.
 */
const CONTAINED_DEPTH = 3;
const CONTAINED_LIMIT = 20_000;

/**
 * Pasta de app em Application Support que leva configuração junto (User/settings.json,
 * state.vscdb com chats e tokens). Só lá: em ~/.npm ou numa extensão, um settings.json é parte
 * de um pacote, não da pessoa.
 */
export async function containsSettings(path: string, ctx: AiContext): Promise<boolean> {
  if (!path.startsWith(join(ctx.home, 'Library/Application Support') + '/')) return false;
  let seen = 0;
  let level = [path];
  for (let depth = 0; depth < CONTAINED_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (++seen > CONTAINED_LIMIT) return false;
        if (CONTAINED_NEVER.has(entry.name)) return true;
        if (entry.isDirectory() && entry.name !== 'node_modules') next.push(join(dir, entry.name));
      }
    }
    level = next;
  }
  return false;
}

/** Pastas que guardam muito mais do que lixo: nem elas nem quem as contém saem. */
function protectedRoots(ctx: AiContext): string[] {
  const h = (relative: string) => join(ctx.home, relative);
  const claude = ctx.env.CLAUDE_CONFIG_DIR || h('.claude');
  const support = (app: string) => h(`Library/Application Support/${app}`);
  return [
    ...[...CLAUDE_KEEP, 'jobs'].map((name) => join(claude, name)),
    h('.local/bin'),
    h('.local/state'),
    h('.local/share/claude'),
    h('.local/share/claude/versions'),
    support('Claude'),
    support('Claude/vm_bundles'),
    support('Codex'),
    support('Antigravity'),
    support('Code'),
    support('Code/User'),
    support('Code/User/workspaceStorage'),
    support('Code/User/globalStorage'),
    support('Google'),
    support('Google/Chrome'),
    h('Library/Logs/Claude'),
    ...(ctx.env.CODEX_HOME ? [ctx.env.CODEX_HOME] : []),
    ...(ctx.env.GEMINI_CLI_HOME ? [join(ctx.env.GEMINI_CLI_HOME, '.gemini')] : []),
    h('.gemini/antigravity'),
    h('.antigravity'),
    h('.antigravity/extensions'),
    ctx.home,
    h('Library'),
    h('Library/Application Support'),
    h('Library/Caches'),
    h('Library/Logs'),
    h('Library/Containers'),
    h('Library/Group Containers'),
    h('Library/CloudStorage'),
    h('Documents'),
    h('Desktop'),
    h('Downloads'),
    claude,
    join(claude, 'projects'),
    h('.codex'),
    h('.gemini'),
    h('.copilot'),
    h('.config'),
    h('.cache'),
    h('.local'),
    h('.local/share'),
    h('.lmstudio'),
    h('.lmstudio/models'),
    h('.ollama'),
    h('.ollama/models'),
    h('.npm'),
    h('.cursor'),
    h('.vscode'),
    h('.vscode/extensions'),
    ctx.tmp,
    `/private/tmp/claude-${ctx.uid}`,
    // Projeto que é uma worktree não conta: tirar worktree é justamente o que a tela faz.
    ...ctx.projects.filter((path) => !isWorktreePath(path)),
  ].map((path) => resolve(path));
}

/**
 * A última trava antes da Lixeira, para o caso de um coletor errar: só caminho absoluto dentro
 * da conta ou dos temporários dela, nunca configuração, credencial, memória, a pasta de um
 * projeto ou uma pasta que contenha qualquer uma delas. O conteúdo das pastas de app em
 * Application Support é conferido à parte, na remoção (containsSettings).
 */
export function refuse(path: string, ctx: AiContext): string | null {
  if (!path.startsWith('/') || resolve(path) !== path) return 'not absolute';
  const unsafe = validatePathSafety(path);
  if (unsafe) return unsafe;

  const roots = [ctx.home, ctx.tmp, '/private/var/folders', '/var/folders', '/private/tmp', '/tmp'];
  if (!roots.some((root) => path.startsWith(resolve(root) + '/'))) return 'outside the account';

  for (const root of protectedRoots(ctx)) {
    if (root === path || root.startsWith(path + '/')) return `contains ${root}`;
  }

  const claude = resolve(ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude'));
  // ~/.claude/projects/<projeto> inteira leva a memória junto.
  if (dirname(path) === join(claude, 'projects')) return 'whole project folder';
  if (path.startsWith(claude + '/')) {
    if (path.split('/').includes('memory')) return 'memory';
    if (CLAUDE_KEEP.has(path.slice(claude.length + 1).split('/')[0])) return 'claude state';
  }
  if (/\/Library\/(Group )?Containers\//.test(path)) return 'container';

  const name = basename(path);
  if (NEVER_NAMES.has(name) || NEVER_PATTERN.test(name)) return 'configuration';
  return null;
}

const idOf = (item: Found) => (item.key ? `${item.path}#${item.key}` : item.path);
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/');

export class AiScanner {
  private known = new Map<string, Found>();
  private knownPaths = new Set<string>();

  constructor(
    private readonly collectors: readonly Collector[],
    private readonly makeContext: () => Promise<AiContext>
  ) {}

  /** O "Mostrar no Finder" só aponta o que a última análise listou. */
  knows(path: string): boolean {
    return this.knownPaths.has(path);
  }

  async scan(onProgress?: (progress: AiProgress) => void): Promise<AiScanDTO> {
    const ctx = await this.makeContext();
    const found: Found[] = [];
    const failed: string[] = [];
    let done = 0;
    let next = 0;
    onProgress?.({ done, total: this.collectors.length });

    const worker = async () => {
      while (next < this.collectors.length) {
        const collector = this.collectors[next++];
        try {
          found.push(...(await collector.collect(ctx)));
        } catch {
          failed.push(collector.id);
        }
        onProgress?.({ done: ++done, total: this.collectors.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, this.collectors.length) }, worker));

    // Um caminho só conta uma vez. Item dentro de outro também sai: os bytes já estão no de fora.
    const unique = new Map<string, Found>();
    for (const item of found) {
      if (item.size <= 0 || unique.has(idOf(item))) continue;
      unique.set(idOf(item), item);
    }
    const all = [...unique.values()];
    const kept = all.filter(
      (item) => !all.some((other) => other !== item && (other.paths ?? [other.path]).some((outer) => outer !== item.path && inside(item.path, outer)))
    );

    for (const item of kept) {
      if (item.blocked) continue;
      // Sem a lista de processos ninguém garante que o item está livre.
      if (!ctx.processesKnown) item.blocked = 'unverified';
      else if ((item.paths ?? [item.path]).some((path) => ctx.inUse(path))) item.blocked = 'in-use';
    }

    this.known = new Map(kept.map((item) => [idOf(item), item]));
    this.knownPaths = new Set(kept.map((item) => item.path));
    const items = kept
      .map((item) => this.toDTO(item, ctx))
      .sort((a, b) => b.size - a.size);
    // Uma ferramenta pode ter mais de um coletor (o Copilot tem três): o nome sai uma vez só.
    return { scannedAt: ctx.now, items, failed: [...new Set(failed)].sort() };
  }

  private toDTO(item: Found, ctx: AiContext): AiItemDTO {
    // Só o que a tela usa: os caminhos e as funções de remoção ficam no processo principal.
    const live = !!item.blocked && LIVE.has(item.blocked);
    const dto: AiItemDTO = {
      id: idOf(item),
      tool: item.tool,
      kind: item.kind,
      label: item.label,
      project: item.project,
      path: item.path,
      size: item.size,
      count: item.count,
      // Relógio adiantado ou arquivo com data no futuro não deixa o item quente por dias.
      lastUsed: Math.min(item.lastUsed, ctx.now),
      confidence: item.confidence ?? 'high',
      heat: live ? 'hot' : item.junk || ctx.isCold(Math.min(item.lastUsed, ctx.now)) ? 'cold' : 'hot',
      safety: item.safety,
      removal: item.removal,
    };
    if (item.junk) dto.junk = item.junk;
    if (item.blocked) dto.blocked = item.blocked;
    if (item.hint) dto.hint = item.hint;
    return dto;
  }

  async remove(ids: readonly string[]): Promise<AiRemoveResultDTO> {
    const result: AiRemoveResultDTO = { removed: 0, freedSpace: 0, failed: [] };
    const chosen = ids.map((id) => [id, this.known.get(id)] as const);
    if (chosen.length === 0) return result;
    const ctx = await this.makeContext();

    for (const [id, item] of chosen) {
      if (!item) {
        result.failed.push({ id });
        continue;
      }
      if (item.removal === 'none' || item.blocked) {
        result.failed.push({ id, blocked: item.blocked });
        continue;
      }
      const paths = item.paths ?? [item.path];
      const blocked = !ctx.processesKnown
        ? 'unverified'
        : paths.some((path) => ctx.inUse(path))
          ? 'in-use'
          : await item.recheck?.(ctx).catch(() => 'unverified' as const);
      if (blocked) {
        result.failed.push({ id, blocked });
        continue;
      }
      try {
        if (paths.some((path) => refuse(path, ctx) !== null)) throw new Error('refused');
        if (item.remove) {
          await item.remove(ctx);
        } else {
          for (const path of paths) {
            if (await containsSettings(path, ctx)) throw new Error('refused: holds settings');
          }
          for (const path of paths) {
            if (await lstat(path).catch(() => null)) await ctx.trash(path);
          }
        }
        result.removed++;
        result.freedSpace += item.size;
        this.known.delete(id);
      } catch {
        result.failed.push({ id });
      }
    }
    return result;
  }
}
