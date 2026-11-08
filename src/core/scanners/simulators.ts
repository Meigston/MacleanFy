import { access, lstat, readdir, readFile, realpath, stat, unlink } from 'fs/promises';
import { constants } from 'fs';
import { spawn } from 'child_process';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { BaseScanner } from './base-scanner.js';
import {
  CATEGORIES,
  type CleanableItem,
  type CleanResult,
  type ItemFlag,
  type ScanResult,
  type ScannerOptions,
} from '../types.js';
import { exists, getSize, removeItem, type FreedFn } from '../utils/fs.js';

/**
 * iOS simulators and Android emulators, one item per virtual device.
 *
 * Both are read from disk, so nothing here needs Xcode or Android Studio to be
 * installed: a Mac that lost Xcode still carries gigabytes of simulators. When
 * `simctl` is there it tells which simulators can still open and deletes them
 * the way Xcode does; without it the folder goes.
 *
 * Xcode's `usr/bin/simctl` is a script that runs `xcodebuild -runFirstLaunch`
 * (an install that asks for the administrator password) when Xcode was updated
 * and not opened since. A scan must never set that off, so the script's check
 * is repeated here and the binary behind it is called directly; while Xcode is
 * waiting for that first launch, its simulators are listed but not deleted.
 *
 * A device that is open right now is listed but flagged `running`, and `clean`
 * checks again before touching it: deleting a booted simulator or a running
 * emulator pulls the disk from under it.
 */

/** Stdout of a finished command, or null when it failed or could not start. */
export type Runner = (command: string, args: string[], env?: Record<string, string>) => Promise<string | null>;

/** The simctl binary and the Xcode it belongs to. */
export interface SimctlCommand {
  path: string;
  developerDir: string;
}

/** `blocked`: Xcode is there but has to be opened once before simctl can answer. */
export type Simctl = SimctlCommand | 'blocked' | null;

export interface SimulatorsDeps {
  home?: string;
  env?: Record<string, string | undefined>;
  run?: Runner;
  /** The simctl to use. Found through xcode-select when left out. */
  simctl?: Simctl;
}

interface Device {
  kind: 'ios' | 'android';
  /** UDID of the simulator. */
  id: string;
  /** Every name an AVD is registered under: one per .ini that points at the folder. */
  names?: string[];
  inis?: string[];
}

interface Found extends Device {
  item: CleanableItem;
}

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const LIVE_SIMCTL_STATES = new Set(['Booting', 'Booted', 'Shutting Down']);
const SIZE_CONCURRENCY = 4;
const COMMAND_TIMEOUT_MS = 30_000;

const ANDROID_VERSIONS: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9',
  29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16',
};

const run: Runner = (command, args, env) =>
  new Promise((done) => {
    let stdout = '';
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: COMMAND_TIMEOUT_MS,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? stdout : null));
  });

// ---------------------------------------------------------------------------
// Reading what Xcode and Android Studio leave on disk
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()];
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

/** The top-level keys of an XML plist; dates come back as text, nested values are skipped. */
export function parsePlist(xml: string): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const body = xml.match(/<plist[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/);
  if (!body) return out;
  // Nested dicts and arrays go first, innermost out, so their keys never pass for top-level ones.
  let top = body[1];
  const nested = /<(dict|array)>(?:(?!<(?:dict|array)>)[\s\S])*?<\/\1>/g;
  for (let before = ''; before !== top; ) {
    before = top;
    top = top.replace(nested, '<nested/>');
  }
  const pair = /<key>([^<]*)<\/key>\s*(?:<(string|date|integer|real)>([^<]*)<\/\2>|<(true|false)\s*\/>|<(string|date)\s*\/>)/g;
  for (const match of top.matchAll(pair)) {
    const key = unescapeXml(match[1]);
    if (match[4]) out[key] = match[4] === 'true';
    else if (match[5]) out[key] = '';
    else if (match[2] === 'integer' || match[2] === 'real') out[key] = Number(match[3]);
    else out[key] = unescapeXml(match[3]);
  }
  return out;
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-2` → `iOS 26.2`. */
export function runtimeName(id: string): string {
  const match = id.match(/SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/);
  if (!match) return '';
  const platform = match[1] === 'xrOS' ? 'visionOS' : match[1];
  return `${platform} ${match[2].replace(/-/g, '.')}`;
}

/** `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro` → `iPhone 17 Pro`. */
export function deviceTypeName(id: string): string {
  const match = id.match(/SimDeviceType\.(.+)$/);
  return match ? match[1].replace(/-/g, ' ') : '';
}

/**
 * Whether a simulator's name already says its model. Xcode names a new one
 * "iPad Pro 11-inch (M4)" for the type `iPad-Pro-11-inch-M4-8GB`: only a name
 * the person chose ("iPhone Bancada B") needs the model next to it.
 */
export function sameModel(name: string, model: string): boolean {
  const flat = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return model === '' || flat(model).startsWith(flat(name));
}

/** Availability and state of each simulator, from `simctl list -j devices`. */
export function parseSimctlDevices(output: string | null): Map<string, { available: boolean; state: string }> | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as { devices?: Record<string, unknown> };
    if (!parsed.devices || typeof parsed.devices !== 'object') return null;
    const devices = new Map<string, { available: boolean; state: string }>();
    for (const list of Object.values(parsed.devices)) {
      if (!Array.isArray(list)) continue;
      for (const device of list as Array<Record<string, unknown>>) {
        if (typeof device.udid !== 'string') continue;
        devices.set(device.udid.toUpperCase(), {
          available: device.isAvailable !== false,
          state: typeof device.state === 'string' ? device.state : '',
        });
      }
    }
    return devices;
  } catch {
    return null;
  }
}

/** `key=value` lines of the files an AVD is made of. */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0 || line.trimStart().startsWith('#')) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** `Android 15 · API 35 · Google Play`, from an AVD's config.ini. */
export function androidDetail(config: Record<string, string>): string {
  const source = config['image.sysdir.1'] ?? config.target ?? '';
  const api = source.match(/android-(\d+)(?:\.(\d+))?/);
  const parts: string[] = [];
  if (api) {
    const version = ANDROID_VERSIONS[Number(api[1])];
    if (version) parts.push(`Android ${version}`);
    parts.push(`API ${api[2] ? `${api[1]}.${api[2]}` : api[1]}`);
  }
  const tag = config['tag.display'];
  if (tag && tag !== 'Default') parts.push(tag);
  return parts.join(' · ');
}

/** UDIDs of the simulators whose launchd_sim is running. */
export function bootedSimulators(ps: string): Set<string> {
  const booted = new Set<string>();
  for (const line of ps.split('\n')) {
    if (!line.includes('launchd_sim')) continue;
    for (const match of line.matchAll(/CoreSimulator\/Devices\/([0-9A-F-]{36})\//gi)) {
      booted.add(match[1].toUpperCase());
    }
  }
  return booted;
}

/** Names of the AVDs an emulator process was started with (`-avd name` or `@name`). */
export function runningEmulators(ps: string): Set<string> {
  const running = new Set<string>();
  for (const line of ps.split('\n')) {
    if (!/qemu-system|\/emulator\b|^emulator\b/.test(line)) continue;
    const words = line.trim().split(/\s+/);
    words.forEach((word, index) => {
      if (word === '-avd' && words[index + 1]) running.add(words[index + 1]);
      else if (word.startsWith('@') && word.length > 1) running.add(word.slice(1));
    });
  }
  return running;
}

async function mapLimit<T, R>(list: T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const index = next++;
      out[index] = await work(list[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The same folder reached through a symlink is still one AVD. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A plist as its top-level keys; binary ones go through plutil, which ships with macOS. */
async function readPlist(path: string, runner: Runner): Promise<Record<string, string | number | boolean> | null> {
  try {
    const raw = await readFile(path);
    const xml =
      raw.subarray(0, 6).toString() === 'bplist'
        ? await runner('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path])
        : raw.toString('utf-8');
    return xml ? parsePlist(xml) : null;
  } catch {
    return null;
  }
}

/**
 * The simctl of the first Xcode found in `developerDirs`. When it is Xcode's
 * wrapper script, the version check the script makes is made here instead:
 * a mismatch means the script would start `xcodebuild -runFirstLaunch`, so the
 * answer is `blocked` and nothing is run.
 */
export async function locateSimctl(developerDirs: Array<string | undefined>, runner: Runner): Promise<Simctl> {
  for (const dir of developerDirs) {
    if (!dir || !isAbsolute(dir)) continue;
    const wrapper = join(dir, 'usr', 'bin', 'simctl');
    if (!(await isExecutable(wrapper))) continue;

    let head: string;
    try {
      head = (await readFile(wrapper)).subarray(0, 4096).toString('utf-8');
    } catch {
      continue;
    }
    if (!head.startsWith('#!')) return { path: wrapper, developerDir: dir };

    const expected = head.match(/EXPECTED_VERSION="([^"]+)"/)?.[1];
    const target = head.match(/exec\s+"(\/[^"]+\/bin\/simctl)"/)?.[1];
    if (!expected || !target || !(await isExecutable(target))) return 'blocked';
    // .../CoreSimulator.framework/Versions/A/Resources/bin/simctl → .../Resources/Info.plist
    const info = await readPlist(join(dirname(dirname(target)), 'Info.plist'), runner);
    if (String(info?.CFBundleVersion ?? '') !== expected) return 'blocked';
    return { path: target, developerDir: dir };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

export class SimulatorsScanner extends BaseScanner {
  category = CATEGORIES['simulators'];
  /** What the last scan found, by path: `clean` only acts on these. */
  private devices = new Map<string, Device>();

  constructor(private readonly deps: SimulatorsDeps = {}) {
    super();
  }

  private get home(): string {
    return this.deps.home ?? homedir();
  }

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  private run(command: string, args: string[], env?: Record<string, string>): Promise<string | null> {
    return (this.deps.run ?? run)(command, args, env);
  }

  private simctl(command: SimctlCommand, args: string[]): Promise<string | null> {
    return this.run(command.path, args, { DEVELOPER_DIR: command.developerDir });
  }

  /** Simulators by UDID, or null when simctl is missing, blocked or did not answer. */
  private async listSimulators(simctl: Simctl) {
    return typeof simctl === 'object' && simctl ? parseSimctlDevices(await this.simctl(simctl, ['list', '-j', 'devices'])) : null;
  }

  private get simulatorRoot(): string {
    return join(this.home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
  }

  private get avdHome(): string {
    const { ANDROID_AVD_HOME, ANDROID_USER_HOME } = this.env;
    if (ANDROID_AVD_HOME && isAbsolute(ANDROID_AVD_HOME)) return ANDROID_AVD_HOME;
    if (ANDROID_USER_HOME && isAbsolute(ANDROID_USER_HOME)) return join(ANDROID_USER_HOME, 'avd');
    return join(this.home, '.android', 'avd');
  }

  async scan(_options?: ScannerOptions): Promise<ScanResult> {
    const ps = (await this.run('/bin/ps', ['-axww', '-o', 'command='])) ?? '';
    const found = [...(await this.simulators(ps)), ...(await this.emulators(ps))];
    this.devices = new Map(found.map(({ item, ...device }) => [item.path, device]));
    return this.createResult(found.map((entry) => entry.item));
  }

  private async findSimctl(): Promise<Simctl> {
    if (this.deps.simctl !== undefined) return this.deps.simctl;
    // xcode-select is a real binary: on a Mac without Xcode it fails instead of offering to install anything.
    const selected = (await this.run('/usr/bin/xcode-select', ['-p']))?.trim();
    return locateSimctl([selected, '/Applications/Xcode.app/Contents/Developer'], (...args) => this.run(...args));
  }

  private async simulators(ps: string): Promise<Found[]> {
    let names: string[];
    try {
      names = (await readdir(this.simulatorRoot)).filter((name) => UDID.test(name));
    } catch {
      return [];
    }
    if (names.length === 0) return [];

    const listed = await this.listSimulators(await this.findSimctl());
    const booted = bootedSimulators(ps);

    const found = await mapLimit(names, SIZE_CONCURRENCY, async (folder): Promise<Found | null> => {
      const path = join(this.simulatorRoot, folder);
      const udid = folder.toUpperCase();
      const plist = await readPlist(join(path, 'device.plist'), (...args) => this.run(...args));
      if (!plist || plist.isDeleted === true) return null;
      if (typeof plist.UDID === 'string' && plist.UDID.toUpperCase() !== udid) return null;
      if (!(await isRealDirectory(path))) return null;

      const known = listed?.get(udid);
      const flags: ItemFlag[] = [];
      // The state saved in device.plist can be stale for good (Xcode removed with a simulator on);
      // without simctl, only a running launchd_sim says it is open.
      if (booted.has(udid) || (known && LIVE_SIMCTL_STATES.has(known.state))) flags.push('running');
      // Only simctl can tell; without it nothing is flagged rather than everything.
      if (listed && (!known || !known.available)) flags.push('unavailable');

      const name = typeof plist.name === 'string' && plist.name ? plist.name : udid;
      const model = typeof plist.deviceType === 'string' ? deviceTypeName(plist.deviceType) : '';
      const system = typeof plist.runtime === 'string' ? runtimeName(plist.runtime) : '';
      const detail = [sameModel(name, model) ? '' : model, system].filter(Boolean).join(' · ');
      const bootedAt = typeof plist.lastBootedAt === 'string' ? Date.parse(plist.lastBootedAt) : NaN;
      const usedAt = Number.isFinite(bootedAt) ? new Date(bootedAt) : undefined;

      return {
        kind: 'ios',
        id: udid,
        item: {
          path,
          name,
          size: await getSize(path),
          isDirectory: true,
          modifiedAt: usedAt ?? new Date((await mtimeOf(path)) ?? Date.now()),
          detail,
          usedAt,
          flags,
        },
      };
    });
    return found.filter((entry): entry is Found => entry !== null);
  }

  private async sdkRoot(): Promise<string | null> {
    const { ANDROID_HOME, ANDROID_SDK_ROOT } = this.env;
    for (const dir of [ANDROID_HOME, ANDROID_SDK_ROOT, join(this.home, 'Library', 'Android', 'sdk')]) {
      if (dir && isAbsolute(dir) && (await isRealDirectory(dir))) return dir;
    }
    return null;
  }

  private async emulators(ps: string): Promise<Found[]> {
    const home = this.avdHome;
    let entries: string[];
    try {
      entries = await readdir(home);
    } catch {
      return [];
    }

    const registered = new Map<string, { names: string[]; inis: string[]; path: string }>();
    for (const entry of entries.filter((name) => name.endsWith('.ini'))) {
      const name = entry.slice(0, -'.ini'.length);
      let config: Record<string, string>;
      try {
        config = parseIni(await readFile(join(home, entry), 'utf-8'));
      } catch {
        continue;
      }
      const candidates = [
        config.path && isAbsolute(config.path) ? config.path : undefined,
        config['path.rel'] ? resolve(dirname(home), config['path.rel']) : undefined,
        join(home, `${name}.avd`),
      ];
      for (const candidate of candidates) {
        if (candidate && (await this.isAvd(candidate))) {
          const path = await canonical(candidate);
          const known = registered.get(path) ?? { names: [], inis: [], path };
          known.names.push(name);
          known.inis.push(join(home, entry));
          registered.set(path, known);
          break;
        }
      }
    }
    // A folder no .ini points to is one Android Studio no longer lists.
    for (const entry of entries.filter((name) => name.endsWith('.avd'))) {
      const path = await canonical(join(home, entry));
      if (!registered.has(path) && (await this.isAvd(path))) {
        registered.set(path, { names: [basename(path, '.avd')], inis: [], path });
      }
    }
    if (registered.size === 0) return [];

    const sdk = await this.sdkRoot();
    const running = runningEmulators(ps);

    return mapLimit([...registered.values()], SIZE_CONCURRENCY, async ({ names, inis, path }): Promise<Found> => {
      let config: Record<string, string> = {};
      try {
        config = parseIni(await readFile(join(path, 'config.ini'), 'utf-8'));
      } catch {
        // An AVD without config.ini still takes space; it just has less to say.
      }

      const flags: ItemFlag[] = [];
      if (names.some((name) => running.has(name))) flags.push('running');
      const image = config['image.sysdir.1'];
      const missingImage = sdk !== null && image !== undefined && !(await exists(join(sdk, image)));
      if (inis.length === 0 || missingImage) flags.push('unavailable');

      const used = Math.max(
        (await mtimeOf(join(path, 'hardware-qemu.ini'))) ?? 0,
        (await mtimeOf(join(path, 'emulator-user.ini'))) ?? 0
      );
      const usedAt = used > 0 ? new Date(used) : undefined;

      let iniBytes = 0;
      for (const ini of inis) iniBytes += await getSize(ini);

      return {
        kind: 'android',
        id: names[0],
        names,
        inis,
        item: {
          path,
          name: config['avd.ini.displayname'] || names[0].replace(/_/g, ' '),
          size: (await getSize(path)) + iniBytes,
          isDirectory: true,
          modifiedAt: usedAt ?? new Date((await mtimeOf(path)) ?? Date.now()),
          detail: androidDetail(config),
          usedAt,
          flags,
        },
      };
    });
  }

  /** An AVD folder is a real directory named `*.avd` with a config.ini inside; nothing else is deleted. */
  private async isAvd(path: string): Promise<boolean> {
    return path.endsWith('.avd') && (await isRealDirectory(path)) && (await exists(join(path, 'config.ini')));
  }

  async clean(items: CleanableItem[], dryRun = false, onFreed?: FreedFn): Promise<CleanResult> {
    const chosen = items.flatMap((item) => {
      const device = this.devices.get(item.path);
      return device ? [{ item, device }] : [];
    });

    if (dryRun) {
      for (const { item } of chosen) onFreed?.(item.size);
      return {
        category: this.category,
        cleanedItems: chosen.length,
        freedSpace: chosen.reduce((sum, { item }) => sum + item.size, 0),
        errors: [],
      };
    }

    const errors: string[] = [];
    // Whatever was opened since the scan stays: the list on screen can be minutes old.
    // Without the process list there is no telling, so nothing goes.
    const ps = await this.run('/bin/ps', ['-axww', '-o', 'command=']);
    if (ps === null) {
      return {
        category: this.category,
        cleanedItems: 0,
        freedSpace: 0,
        errors: chosen.map(({ item }) => `Could not check whether ${item.name} is open`),
      };
    }
    const booted = bootedSimulators(ps);
    const emulators = runningEmulators(ps);
    const simctl = chosen.some(({ device }) => device.kind === 'ios') ? await this.findSimctl() : null;
    const listed = await this.listSimulators(simctl);

    let cleanedItems = 0;
    let freedSpace = 0;

    for (const { item, device } of chosen) {
      const known = device.kind === 'ios' ? listed?.get(device.id) : undefined;
      const open =
        device.kind === 'ios'
          ? booted.has(device.id) || (known !== undefined && LIVE_SIMCTL_STATES.has(known.state))
          : (device.names ?? []).some((name) => emulators.has(name));
      if (open) {
        errors.push(`${item.name} is open; close it before deleting`);
        continue;
      }

      if (device.kind === 'ios' && simctl === 'blocked') {
        errors.push(`Xcode needs to be opened once to finish setting up before ${item.name} can be deleted`);
        continue;
      }
      if (device.kind === 'ios' && simctl && !listed) {
        // simctl is there but did not answer: removing the folder by hand would leave Xcode's list pointing at nothing.
        errors.push(`Could not ask Xcode about ${item.name}`);
        continue;
      }

      let removed: boolean;
      if (device.kind === 'ios' && typeof simctl === 'object' && simctl && known) {
        // simctl takes it out of Xcode's device list too, not only off the disk.
        removed = (await this.simctl(simctl, ['delete', device.id])) !== null && !(await exists(item.path));
        if (removed) onFreed?.(item.size);
      } else {
        removed = await removeItem(item.path, false, onFreed);
        for (const ini of removed ? (device.inis ?? []) : []) {
          const bytes = await getSize(ini);
          if (await unlink(ini).then(() => true, () => false)) onFreed?.(bytes);
        }
      }

      if (removed) {
        cleanedItems++;
        freedSpace += item.size;
        this.devices.delete(item.path);
      } else {
        errors.push(`Could not delete ${item.name}`);
      }
    }

    return { category: this.category, cleanedItems, freedSpace, errors };
  }
}
