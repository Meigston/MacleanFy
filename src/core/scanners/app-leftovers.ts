import { execFile } from 'child_process';
import { lstat, readdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { BaseScanner } from './base-scanner.js';
import { CATEGORIES, type CleanableItem, type ScanResult, type ScannerOptions } from '../types.js';
import { getSize } from '../utils/index.js';

/**
 * Data left in ~/Library by apps that are no longer on the Mac.
 *
 * Folder names alone cannot tell an app's data apart: Java writes preferences
 * under package names (the IRPF tax program writes `serpro.ppgd.irpf`), and
 * analytics SDKs write under their own vendor (`com.firebase…`, `com.amplitude…`)
 * inside apps that are still installed. So an identifier only counts as an app
 * when macOS itself filed something under it — HTTPStorages, WebKit and Saved
 * Application State are written per running app bundle. From there, it is a
 * leftover only when:
 *
 * - no installed app has it, nor shares its vendor (Office apps share
 *   `com.microsoft.office`, for instance), nor does a launchd job or privileged
 *   helper from that vendor;
 * - Launch Services cannot resolve it to an app anywhere (it also knows apps
 *   nested inside other apps and on other volumes);
 * - nothing under it changed in the last 30 days;
 * - it is not on the never-delete list.
 *
 * Many apps also keep a folder named after themselves (`Application Support/Trae`).
 * Such a folder joins a leftover when its name is a distinctive word of the
 * identifier (`trae` in `com.trae.app`) and is neither the name nor a word of any
 * installed app.
 *
 * Containers and Group Containers are left alone: macOS guards them, and
 * touching another app's container asks the person for permission.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_DAYS = 30;

/** Below this many installed apps the picture is incomplete, and nothing is reported. */
const MIN_INSTALLED_APPS = 10;

/** Folders macOS fills per app bundle: proof that an identifier belonged to an app. */
const EVIDENCE_FOLDERS = ['HTTPStorages', 'WebKit', 'Saved Application State'];

/** Where an app's data lives in ~/Library, named after its bundle identifier. */
const DATA_FOLDERS = [
  'Caches',
  'Preferences',
  join('Preferences', 'ByHost'),
  'Application Support',
  'Logs',
  'HTTPStorages',
  'WebKit',
  'Saved Application State',
];

/**
 * Never reported, installed or not. Password managers keep vaults and settings
 * people expect back on reinstall; device-management and security agents are
 * managed by someone else; Electron's default identifier belongs to every app
 * under development.
 */
const NEVER_DELETE = [
  'com.apple.',
  'group.',
  'systemgroup.',
  'dev.macleanfy.',
  'com.agilebits.',
  'com.1password.',
  'com.bitwarden.',
  'com.lastpass.',
  'com.dashlane.',
  'org.keepassxc.',
  'com.keepersecurity.',
  'com.jamf',
  'com.kandji.',
  'com.crowdstrike.',
  'com.paloaltonetworks.',
  'com.github.electron',
];

/** Folders where apps also keep data under their own name, not their identifier. */
const NAME_FOLDERS = ['Application Support', 'Caches', 'Logs'];

/** Words too common to tie a folder to one app. */
const COMMON_WORDS = new Set(
  (
    'app apps application mac macos osx desktop helper helpers client agent service services daemon launcher ' +
    'updater update installer setup beta preview release stable nightly lite plus free pro studio editor code ' +
    'data cache caches files file logs mail music notes photos player viewer reader browser chat assistant tool ' +
    'tools sync cloud drive share shared web site main core base common default user users team labs software ' +
    'inc ltd llc gmbh corp company'
  ).split(' ')
);

/** Hosts shared by unrelated developers: there the vendor is the third part. */
const SHARED_VENDORS = new Set(['com.github', 'io.github', 'com.googlecode', 'net.sourceforge', 'com.electron']);

const BYHOST_SUFFIX = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.plist$/i;

/**
 * The bundle identifier a Library entry is named after, or null when the name
 * is not one. `com.vendor.app`, `com.vendor.app.plist`, `com.vendor.app.savedState`,
 * `com.vendor.app.binarycookies` and ByHost's `com.vendor.app.<UUID>.plist` all
 * give `com.vendor.app`.
 */
export function bundleIdOf(name: string): string | null {
  const id = name.replace(BYHOST_SUFFIX, '').replace(/\.(plist|savedState|binarycookies)$/i, '');
  return /^[a-z][a-z0-9-]*\.[a-z0-9-]+\.[a-z0-9._-]*[a-z0-9]$/i.test(id) ? id : null;
}

export function vendorOf(id: string): string {
  const parts = id.toLowerCase().split('.');
  const vendor = parts.slice(0, 2).join('.');
  return SHARED_VENDORS.has(vendor) && parts.length > 2 ? parts.slice(0, 3).join('.') : vendor;
}

/** Lowercase letters and digits only: `Royal TSX` and `RoyalTSX` meet as `royaltsx`. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The words of an identifier distinctive enough to name an app's folder. */
export function distinctiveWords(id: string): string[] {
  return id
    .split('.')
    .slice(1)
    .map(normalizeName)
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word) && !COMMON_WORDS.has(word));
}

export function isNeverDeleted(id: string): boolean {
  const lower = id.toLowerCase();
  return NEVER_DELETE.some((prefix) => lower.startsWith(prefix));
}

export interface InstalledApp {
  id: string;
  /** The bundle's file name, without `.app`. */
  name: string;
}

/** What the scanner asks macOS. Injected so tests can stand in for it. */
export interface InstalledApps {
  list(): Promise<InstalledApp[]>;
  /** The identifiers Launch Services still resolves to an app somewhere. */
  resolvable(ids: string[]): Promise<Set<string>>;
}

export interface AppLeftoversOptions {
  home?: string;
  apps?: InstalledApps;
  /** Folders whose file names are launchd labels or helper names, each marking its vendor as present. */
  vendorFolders?: string[];
  now?: () => number;
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** The latest change to an entry: itself, or for a folder, anything directly inside it. */
async function lastChange(path: string): Promise<number> {
  const stats = await lstat(path);
  let newest = stats.mtimeMs;
  if (stats.isDirectory()) {
    for (const name of await list(path)) {
      try {
        newest = Math.max(newest, (await lstat(join(path, name))).mtimeMs);
      } catch {
        continue;
      }
    }
  }
  return newest;
}

export class AppLeftoversScanner extends BaseScanner {
  category = CATEGORIES['app-leftovers'];

  constructor(private readonly options: AppLeftoversOptions = {}) {
    super();
  }

  async scan(_options?: ScannerOptions): Promise<ScanResult> {
    const library = join(this.options.home ?? homedir(), 'Library');
    const apps = this.options.apps ?? macApps;
    const now = (this.options.now ?? Date.now)();

    const evidence = new Map<string, string>();
    for (const folder of EVIDENCE_FOLDERS) {
      for (const name of await list(join(library, folder))) {
        const id = bundleIdOf(name);
        if (id && !isNeverDeleted(id)) evidence.set(id.toLowerCase(), id);
      }
    }
    if (evidence.size === 0) return this.createResult([]);

    const installed = await apps.list().catch(() => [] as InstalledApp[]);
    if (installed.length < MIN_INSTALLED_APPS) {
      return this.createResult([], 'Could not list the installed apps');
    }

    const installedIds = new Set(installed.map((app) => app.id.toLowerCase()));
    const vendors = new Set(installed.map((app) => vendorOf(app.id)));
    // Names a folder of an installed app could have.
    const installedNames = new Set(
      installed.flatMap((app) => [normalizeName(app.name), ...distinctiveWords(app.id)]).filter(Boolean)
    );
    const vendorFolders = this.options.vendorFolders ?? [
      join(library, 'LaunchAgents'),
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      '/Library/PrivilegedHelperTools',
    ];
    for (const folder of vendorFolders) {
      for (const name of await list(folder)) vendors.add(vendorOf(name.replace(/\.plist$/, '')));
    }

    const candidates = [...evidence.values()].filter(
      (id) => !installedIds.has(id.toLowerCase()) && !vendors.has(vendorOf(id))
    );
    if (candidates.length === 0) return this.createResult([]);

    const resolvable = new Set(
      [...(await apps.resolvable(candidates).catch(() => new Set(candidates)))].map((id) => id.toLowerCase())
    );
    const orphans = new Set(candidates.filter((id) => !resolvable.has(id.toLowerCase())).map((id) => id.toLowerCase()));
    if (orphans.size === 0) return this.createResult([]);

    // Every entry of each orphan, grouped so an app touched recently is skipped whole.
    const entries = new Map<string, Array<{ path: string; name: string }>>();
    const taken = new Set<string>();
    const add = (id: string, path: string) => {
      if (taken.has(path)) return;
      taken.add(path);
      const group = entries.get(id) ?? [];
      group.push({ path, name: evidence.get(id) ?? id });
      entries.set(id, group);
    };

    for (const folder of DATA_FOLDERS) {
      for (const name of await list(join(library, folder))) {
        const id = bundleIdOf(name)?.toLowerCase();
        if (id && orphans.has(id)) add(id, join(library, folder, name));
      }
    }

    const byWord = new Map<string, string>();
    for (const id of orphans) {
      for (const word of distinctiveWords(id)) if (!installedNames.has(word) && !byWord.has(word)) byWord.set(word, id);
    }
    for (const folder of NAME_FOLDERS) {
      for (const name of await list(join(library, folder))) {
        if (bundleIdOf(name)) continue;
        const id = byWord.get(normalizeName(name));
        if (id) add(id, join(library, folder, name));
      }
    }

    const items: CleanableItem[] = [];
    for (const group of entries.values()) {
      try {
        const changes = await Promise.all(group.map((entry) => lastChange(entry.path)));
        const newest = Math.max(...changes);
        if (now - newest < IDLE_DAYS * DAY_MS) continue;

        for (const [index, entry] of group.entries()) {
          const stats = await lstat(entry.path);
          items.push({
            path: entry.path,
            name: entry.name,
            size: await getSize(entry.path),
            isDirectory: stats.isDirectory(),
            modifiedAt: new Date(changes[index]),
          });
        }
      } catch {
        continue;
      }
    }

    return this.createResult(items.sort((a, b) => b.size - a.size));
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });
}

/** Reads each bundle's identifier; paths come in as arguments, never inside the script. */
const BUNDLE_IDS_SCRIPT = `
ObjC.import('Foundation');
function run(argv) {
  const lines = [];
  for (const path of argv) {
    const bundle = $.NSBundle.bundleWithPath(path);
    if (bundle.isNil() || bundle.bundleIdentifier.isNil()) continue;
    lines.push(ObjC.unwrap(bundle.bundleIdentifier) + '\\t' + path.split('/').pop().replace(/\\.app$/, ''));
  }
  return lines.join('\\n');
}
`;

const RESOLVE_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  return argv.filter((id) => !workspace.URLForApplicationWithBundleIdentifier(id).isNil()).join('\\n');
}
`;

const APP_FOLDERS = ['/Applications', join(homedir(), 'Applications'), '/System/Applications', '/System/Applications/Utilities'];

/**
 * Spotlight finds apps anywhere, nested ones included; the app folders are read
 * too, so a Mac with Spotlight off still gets a full list.
 */
const macApps: InstalledApps = {
  async list() {
    const found = await run('/usr/bin/mdfind', ["kMDItemContentType == 'com.apple.application-bundle'"]).catch(() => '');
    const paths = new Set(found.split('\n').filter((path) => path.endsWith('.app')));
    for (const folder of APP_FOLDERS) {
      for (const name of await list(folder)) {
        if (name.endsWith('.app')) paths.add(join(folder, name));
        else if (!name.startsWith('.')) {
          // Vendors that ship a folder of apps, like Microsoft Office or Adobe.
          for (const inner of await list(join(folder, name))) {
            if (inner.endsWith('.app')) paths.add(join(folder, name, inner));
          }
        }
      }
    }
    if (paths.size === 0) return [];
    const output = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', BUNDLE_IDS_SCRIPT, ...paths]);
    return output
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([id, name]) => id && name)
      .map(([id, name]) => ({ id, name }));
  },

  async resolvable(ids) {
    if (ids.length === 0) return new Set();
    const output = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', RESOLVE_SCRIPT, ...ids]);
    return new Set(output.split('\n').filter(Boolean));
  },
};
