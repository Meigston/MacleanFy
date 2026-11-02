import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADD_SCRIPT,
  LIST_SCRIPT,
  LoginApps,
  REMOVE_SCRIPT,
  failureStatus,
  parseLoginItems,
  parseState,
  type ScriptResult,
} from './login-apps';

const DENIED = 'execution error: Not authorized to send Apple events to System Events. (-1743)';

/** Um System Events de mentira: guarda a lista e responde aos três scripts. */
function fakeSystemEvents(start: Array<{ name: string; path: string; hidden?: boolean }>) {
  const state = {
    items: start.map((item) => ({ hidden: false, ...item })),
    denied: false,
    /** Faz o macOS aceitar o pedido sem mudar nada, como num item que ele não deixa tirar. */
    ignoreChanges: false,
    calls: [] as Array<{ args: string[]; timeout: number }>,
  };
  const runner = async (args: string[], timeout: number): Promise<ScriptResult> => {
    state.calls.push({ args, timeout });
    if (state.denied) return { ok: false, stderr: DENIED };
    const script = args.filter((_, index) => args[index - 1] === '-e');
    const argv = args.slice(args.lastIndexOf(script[script.length - 1]) + 1);
    if (script[0] === LIST_SCRIPT) return { ok: true, stdout: JSON.stringify(state.items) };
    if (state.ignoreChanges) return { ok: true, stdout: '' };
    if (script.join('\n') === REMOVE_SCRIPT.join('\n')) {
      state.items = state.items.filter((item) => item.path !== argv[0]);
      return { ok: true, stdout: '' };
    }
    if (script.join('\n') === ADD_SCRIPT.join('\n')) {
      state.items.push({ name: argv[0].split('/').pop()!.replace('.app', ''), path: argv[0], hidden: argv[1] === 'true' });
      return { ok: true, stdout: '' };
    }
    return { ok: false, stderr: 'unknown script' };
  };
  return { state, runner };
}

describe('login apps', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'macleanfy-login-apps-'));
    file = join(dir, 'data', 'login-apps.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads what System Events prints and drops what it cannot trust', () => {
    const output = JSON.stringify([
      { name: 'Spotify', path: '/Applications/Spotify.app', hidden: false },
      { name: 'Dropbox', path: '/Applications/Dropbox.app/', hidden: true },
      { name: '', path: '/Applications/Rectangle.app' },
      { name: 'Twice', path: '/Applications/Spotify.app' },
      { name: 'Relative', path: 'Applications/X.app' },
      { name: 'Missing' },
    ]);
    expect(parseLoginItems(output)).toEqual([
      { name: 'Spotify', path: '/Applications/Spotify.app', hidden: false },
      { name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true },
      { name: 'Rectangle', path: '/Applications/Rectangle.app', hidden: false },
    ]);
    expect(parseLoginItems('not json')).toEqual([]);
    expect(parseLoginItems('{}')).toEqual([]);
  });

  it('tells a refused permission from any other failure', () => {
    expect(failureStatus(DENIED)).toBe('denied');
    expect(failureStatus('execution error: System Events got an error: AppleEvent timed out. (-1712)')).toBe('error');
    expect(failureStatus('')).toBe('error');
  });

  it('starts from nothing when the saved state is missing or broken', () => {
    expect(parseState(null)).toEqual({ granted: false, off: [] });
    expect(parseState('{')).toEqual({ granted: false, off: [] });
    expect(parseState('{"granted":true,"off":[{"name":"A","path":"/Applications/A.app"},{"path":3}]}')).toEqual({
      granted: true,
      off: [{ name: 'A', path: '/Applications/A.app', hidden: false }],
    });
  });

  it('never asks macOS on its own before the first click', async () => {
    const { state, runner } = fakeSystemEvents([{ name: 'Spotify', path: '/Applications/Spotify.app' }]);
    const apps = new LoginApps(file, runner);
    expect(await apps.list()).toEqual({ status: 'unasked', apps: [] });
    expect(state.calls).toEqual([]);
  });

  it('asks once, waiting for an answer, and reads by itself after that', async () => {
    const { state, runner } = fakeSystemEvents([
      { name: 'Spotify', path: '/Applications/Spotify.app' },
      { name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true },
    ]);
    const first = await new LoginApps(file, runner).list(true);
    expect(first).toEqual({
      status: 'granted',
      apps: [
        { name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true, off: false },
        { name: 'Spotify', path: '/Applications/Spotify.app', hidden: false, off: false },
      ],
    });
    // Enquanto o pedido está na tela, o System Events espera a pessoa responder.
    expect(state.calls[0].timeout).toBeGreaterThanOrEqual(60_000);

    const later = await new LoginApps(file, runner).list();
    expect(later.status).toBe('granted');
    expect(state.calls).toHaveLength(2);
  });

  it('goes back to waiting for a click when the permission is taken away', async () => {
    const { state, runner } = fakeSystemEvents([]);
    await new LoginApps(file, runner).list(true);
    state.denied = true;
    expect(await new LoginApps(file, runner).list()).toEqual({ status: 'denied', apps: [] });
    expect(await new LoginApps(file, runner).list()).toEqual({ status: 'unasked', apps: [] });
  });

  it('turns an app off and back on, keeping how it opened', async () => {
    const { state, runner } = fakeSystemEvents([{ name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true }]);
    const apps = new LoginApps(file, runner, async () => true);
    await apps.list(true);

    const off = await apps.set('/Applications/Dropbox.app', false);
    expect(off.done).toBe(true);
    expect(state.items).toEqual([]);
    expect(off.list.apps).toEqual([{ name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true, off: true }]);
    // O app saiu do macOS; é o arquivo que lembra dele para pô-lo de volta.
    expect(JSON.parse(await readFile(file, 'utf-8')).off).toEqual([
      { name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true },
    ]);

    const on = await apps.set('/Applications/Dropbox.app', true);
    expect(on.done).toBe(true);
    expect(state.items).toEqual([{ name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true }]);
    expect(on.list.apps).toEqual([{ name: 'Dropbox', path: '/Applications/Dropbox.app', hidden: true, off: false }]);
  });

  it('says so when macOS accepts the request but the app stays', async () => {
    const { state, runner } = fakeSystemEvents([{ name: 'Teams', path: '/Applications/Microsoft Teams.app' }]);
    const apps = new LoginApps(file, runner);
    await apps.list(true);
    state.ignoreChanges = true;
    const result = await apps.set('/Applications/Microsoft Teams.app', false);
    expect(result.done).toBe(false);
    expect(result.list.apps[0].off).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf-8')).off).toEqual([]);
  });

  it('only changes apps from the last list', async () => {
    const { state, runner } = fakeSystemEvents([{ name: 'Spotify', path: '/Applications/Spotify.app' }]);
    const apps = new LoginApps(file, runner);
    await apps.list(true);
    const result = await apps.set('/Applications/Utilities/Terminal.app', true);
    expect(result.done).toBe(false);
    expect(state.calls.some((call) => call.args.includes('/Applications/Utilities/Terminal.app'))).toBe(false);
  });

  it('forgets apps turned off that came back through Settings or left the disk', async () => {
    const { state, runner } = fakeSystemEvents([]);
    await new LoginApps(file, runner).list(true);
    await writeFile(
      file,
      JSON.stringify({
        granted: true,
        off: [
          { name: 'Slack', path: '/Applications/Slack.app' },
          { name: 'Gone', path: '/Applications/Gone.app' },
        ],
      })
    );
    state.items = [{ name: 'Slack', path: '/Applications/Slack.app', hidden: false }];
    const list = await new LoginApps(file, runner, async (path) => path !== '/Applications/Gone.app').list();
    expect(list.apps).toEqual([{ name: 'Slack', path: '/Applications/Slack.app', hidden: false, off: false }]);
    expect(JSON.parse(await readFile(file, 'utf-8')).off).toEqual([]);
  });
});
