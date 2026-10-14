import { readdir, stat, readFile } from 'fs/promises';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import { exists, getSize, isProtectedPath, validatePathSafety } from './utils/index.js';

/**
 * Application discovery and removal.
 *
 * Derived from `src/commands/uninstall.ts` of mac-cleaner-cli, with the terminal
 * prompts stripped out so a GUI can drive it: listing reports progress, and the
 * actual removal is injected (the app moves things to the Trash instead of
 * deleting them outright).
 */

export interface RelatedPath {
  path: string;
  size: number;
  /**
   * Settings and documents the app keeps (Application Support, Preferences,
   * Containers): what someone reinstalling it later would want back. Caches,
   * logs, web storage and saved window state are not.
   */
  personal: boolean;
}

export interface AppInfo {
  name: string;
  path: string;
  bundleId: string | null;
  size: number;
  related: RelatedPath[];
  totalSize: number;
}

export interface UninstallResult {
  uninstalled: number;
  freedSpace: number;
  errors: string[];
}

export interface ListAppsOptions {
  appDirs?: string[];
  home?: string;
  concurrency?: number;
  onProgress?: (completed: number, total: number) => void;
}

/** Removes one path and reports whether it is gone. */
export type RemoveFn = (path: string) => Promise<boolean>;

export interface UninstallOptions {
  /** Leave settings and documents in place, for a later reinstall. */
  keepPersonal?: boolean;
}

/** Where apps leave files in ~/Library, and whether each holds personal data. */
const RELATED_PATHS_TEMPLATES: Array<{ parts: string[]; personal: boolean }> = [
  { parts: ['Library', 'Application Support', '{APP_NAME}'], personal: true },
  { parts: ['Library', 'Application Support', '{BUNDLE_ID}'], personal: true },
  { parts: ['Library', 'Preferences', '{BUNDLE_ID}.plist'], personal: true },
  { parts: ['Library', 'Preferences', '{APP_NAME}.plist'], personal: true },
  { parts: ['Library', 'Preferences', 'ByHost', '{BUNDLE_ID}.*.plist'], personal: true },
  { parts: ['Library', 'Containers', '{BUNDLE_ID}'], personal: true },
  { parts: ['Library', 'Group Containers', '*.{APP_NAME}'], personal: true },
  { parts: ['Library', 'Group Containers', '*.{BUNDLE_ID}'], personal: true },
  { parts: ['Library', 'Application Scripts', '{BUNDLE_ID}'], personal: true },
  { parts: ['Library', 'Caches', '{APP_NAME}'], personal: false },
  { parts: ['Library', 'Caches', '{BUNDLE_ID}'], personal: false },
  { parts: ['Library', 'Logs', '{APP_NAME}'], personal: false },
  { parts: ['Library', 'Logs', '{BUNDLE_ID}'], personal: false },
  { parts: ['Library', 'Saved Application State', '{BUNDLE_ID}.savedState'], personal: false },
  { parts: ['Library', 'WebKit', '{APP_NAME}'], personal: false },
  { parts: ['Library', 'WebKit', '{BUNDLE_ID}'], personal: false },
  { parts: ['Library', 'HTTPStorages', '{BUNDLE_ID}'], personal: false },
  { parts: ['Library', 'HTTPStorages', '{BUNDLE_ID}.binarycookies'], personal: false },
  // A login agent left behind would point at an app that is gone.
  { parts: ['Library', 'LaunchAgents', '{BUNDLE_ID}.plist'], personal: false },
  { parts: ['Library', 'LaunchAgents', '{BUNDLE_ID}.*.plist'], personal: false },
];

/**
 * Escapes all regex metacharacters in a string.
 * This prevents regex injection attacks when using user-provided patterns.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a string against a glob-like pattern.
 * Security: Uses proper regex escaping to prevent regex injection.
 */
function matchPattern(str: string, pattern: string): boolean {
  const regexPattern = escapeRegex(pattern).replace(/\\\*/g, '.*');

  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(str);
  } catch {
    return false;
  }
}

/**
 * Reads the bundle identifier from an app's Info.plist.
 * This is more secure than guessing from the app name.
 */
export async function getBundleId(appPath: string): Promise<string | null> {
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist');
    const content = await readFile(plistPath, 'utf-8');

    const match = content.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (match && match[1]) {
      // Validate the bundle ID format (should be reverse domain notation)
      const bundleId = match[1].trim();
      if (/^[a-zA-Z][a-zA-Z0-9.-]*$/.test(bundleId)) {
        return bundleId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function findRelatedPaths(
  appName: string,
  bundleId: string | null,
  home = homedir()
): Promise<Array<{ path: string; personal: boolean }>> {
  const paths: Array<{ path: string; personal: boolean }> = [];
  // The default macOS volume is case-insensitive: "Demo App" and "demo app" are
  // the same folder, and listing it twice would double its size.
  const seen = new Set<string>();

  // Fall back to guessing if we couldn't read the bundle ID
  const id = bundleId ?? appName.toLowerCase().replace(/\s+/g, '.');

  for (const { parts, personal } of RELATED_PATHS_TEMPLATES) {
    const add = (path: string): void => {
      const key = path.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        paths.push({ path, personal });
      }
    };

    const template = join(home, ...parts);
    const variations = [
      template.replace('{APP_NAME}', appName).replace('{BUNDLE_ID}', id),
      template.replace('{APP_NAME}', appName.toLowerCase()).replace('{BUNDLE_ID}', id),
      template.replace('{APP_NAME}', appName.replace(/\s+/g, '')).replace('{BUNDLE_ID}', id),
    ];

    for (const path of variations) {
      // Security check: ensure the path is within the home directory
      const resolved = resolve(path);
      if (!resolved.startsWith(home + '/')) {
        continue;
      }

      if (isProtectedPath(resolved)) {
        continue;
      }

      if (path.includes('*')) {
        const dir = path.substring(0, path.lastIndexOf('/'));
        const pattern = path.substring(path.lastIndexOf('/') + 1);

        if (await exists(dir)) {
          try {
            const entries = await readdir(dir);
            for (const entry of entries) {
              if (matchPattern(entry, pattern)) {
                const fullPath = join(dir, entry);
                if (!isProtectedPath(fullPath)) add(fullPath);
              }
            }
          } catch {
            continue;
          }
        }
      } else if (await exists(path)) {
        add(path);
      }
    }
  }

  return paths;
}

async function describeApp(appDir: string, entry: string, home: string): Promise<AppInfo | null> {
  const appPath = join(appDir, entry);
  const appName = basename(entry, '.app');

  try {
    const stats = await stat(appPath);
    if (!stats.isDirectory()) return null;

    const bundleId = await getBundleId(appPath);
    const size = await getSize(appPath);

    const related: RelatedPath[] = [];
    for (const { path, personal } of await findRelatedPaths(appName, bundleId, home)) {
      related.push({ path, size: await getSize(path), personal });
    }

    return {
      name: appName,
      path: appPath,
      bundleId,
      size,
      related,
      totalSize: size + related.reduce((sum, r) => sum + r.size, 0),
    };
  } catch {
    return null;
  }
}

/**
 * Lists installed applications with the size of each bundle and of the files
 * it left around the user's Library, largest first.
 */
export async function listInstalledApps(options: ListAppsOptions = {}): Promise<AppInfo[]> {
  const home = options.home ?? homedir();
  const appDirs = options.appDirs ?? ['/Applications', join(home, 'Applications')];
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const candidates: Array<{ appDir: string; entry: string }> = [];
  for (const appDir of appDirs) {
    try {
      for (const entry of await readdir(appDir)) {
        if (entry.endsWith('.app')) candidates.push({ appDir, entry });
      }
    } catch {
      continue;
    }
  }

  const apps: AppInfo[] = [];
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (next < candidates.length) {
      const { appDir, entry } = candidates[next++];
      const info = await describeApp(appDir, entry, home);
      if (info) apps.push(info);
      completed++;
      options.onProgress?.(completed, candidates.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  return apps.sort((a, b) => b.totalSize - a.totalSize);
}

/**
 * Removes each app bundle and then the files related to it. An app whose bundle
 * cannot be removed keeps its related files, so nothing is left half-uninstalled.
 */
export async function uninstallApps(
  apps: AppInfo[],
  remove: RemoveFn,
  options: UninstallOptions = {}
): Promise<UninstallResult> {
  const result: UninstallResult = { uninstalled: 0, freedSpace: 0, errors: [] };

  for (const app of apps) {
    if (validatePathSafety(app.path) !== null || !(await remove(app.path).catch(() => false))) {
      result.errors.push(app.name);
      continue;
    }
    result.freedSpace += app.size;

    for (const related of app.related) {
      if (options.keepPersonal && related.personal) continue;
      if (validatePathSafety(related.path) !== null) continue;
      if (await remove(related.path).catch(() => false)) {
        result.freedSpace += related.size;
      }
    }

    result.uninstalled++;
  }

  return result;
}
