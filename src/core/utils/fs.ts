import { lstat, readdir, rm, rmdir, access, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { CleanableItem } from '../types.js';

/**
 * System paths that should NEVER be deleted.
 * This is a security safeguard against accidental or malicious deletion.
 */
const PROTECTED_PATHS = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var/log',
  '/var/db',
  '/var/root',
  '/private/var/db',
  '/private/var/root',
  '/private/var/log',
  '/Library/Apple',
  '/Applications/Utilities',
];

/**
 * Paths that are explicitly allowed even if they might match protected patterns.
 * These are safe temporary/cache locations.
 */
const ALLOWED_PATHS = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
  '/var/folders',
  '/private/var/folders',
];

/**
 * Checks if a path is a protected system path that should never be deleted.
 */
export function isProtectedPath(path: string): boolean {
  const resolved = resolve(path);
  
  // First check if it's in an explicitly allowed location (like /tmp, /var/folders)
  const isAllowed = ALLOWED_PATHS.some((p) => resolved === p || resolved.startsWith(p + '/'));
  if (isAllowed) {
    return false;
  }
  
  return PROTECTED_PATHS.some((p) => resolved === p || resolved.startsWith(p + '/'));
}

/**
 * Validates that a path is safe to delete.
 * Returns an error message if unsafe, or null if safe.
 */
export function validatePathSafety(path: string): string | null {
  const resolved = resolve(path);
  
  // Check for protected system paths
  if (isProtectedPath(resolved)) {
    return `Refusing to delete protected system path: ${path}`;
  }
  
  // Check for root directory
  if (resolved === '/') {
    return 'Refusing to delete root directory';
  }
  
  // Check for home directory itself
  const home = homedir();
  if (resolved === home) {
    return 'Refusing to delete home directory';
  }
  
  return null;
}

/**
 * Space a file actually occupies on disk, as `du` reports it.
 *
 * A sparse file claims far more than it holds: Docker.raw can show ~1 TB while
 * using 65 GB. Counting the apparent size would promise space that deleting the
 * file never gives back.
 */
export function sizeOnDisk(stats: { size: number; blocks: number }): number {
  return Math.min(stats.size, stats.blocks * 512);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function getSize(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return stats.size;
    }
    if (stats.isFile()) {
      return sizeOnDisk(stats);
    }
    if (stats.isDirectory()) {
      return await getDirectorySize(path);
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          const stats = await lstat(fullPath);
          totalSize += stats.size;
        } else if (entry.isFile()) {
          const stats = await lstat(fullPath);
          totalSize += sizeOnDisk(stats);
        } else if (entry.isDirectory()) {
          totalSize += await getDirectorySize(fullPath);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return 0;
  }

  return totalSize;
}

export async function getItems(
  dirPath: string,
  options: {
    recursive?: boolean;
    minAge?: number;
    minSize?: number;
    maxDepth?: number;
  } = {}
): Promise<CleanableItem[]> {
  const items: CleanableItem[] = [];
  const { recursive = false, minAge, minSize, maxDepth = 10 } = options;

  async function processDir(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    try {
      const entries = await readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentPath, entry.name);

        try {
          const stats = await lstat(fullPath);

          if (minAge) {
            const daysOld = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
            if (daysOld < minAge) continue;
          }

          let size: number;
          if (stats.isSymbolicLink()) {
            size = stats.size;
          } else if (entry.isDirectory()) {
            size = await getDirectorySize(fullPath);
          } else {
            size = sizeOnDisk(stats);
          }

          if (minSize && size < minSize) continue;

          items.push({
            path: fullPath,
            size,
            name: entry.name,
            isDirectory: entry.isDirectory(),
            modifiedAt: stats.mtime,
          });

          if (recursive && entry.isDirectory() && !stats.isSymbolicLink()) {
            await processDir(fullPath, depth + 1);
          }
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  }

  await processDir(dirPath, 0);
  return items;
}

export async function getDirectoryItems(dirPath: string): Promise<CleanableItem[]> {
  const items: CleanableItem[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      try {
        const stats = await lstat(fullPath);
        let size: number;
        if (stats.isSymbolicLink()) {
          size = stats.size;
        } else if (entry.isDirectory()) {
          size = await getDirectorySize(fullPath);
        } else {
          size = sizeOnDisk(stats);
        }

        items.push({
          path: fullPath,
          size,
          name: entry.name,
          isDirectory: entry.isDirectory(),
          modifiedAt: stats.mtime,
        });
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }

  return items;
}

/**
 * Safely removes a file or directory.
 * 
 * Security measures:
 * 1. Validates path is not a protected system path
 * 2. Re-checks file type immediately before deletion to prevent TOCTOU attacks
 * 3. Handles symlinks safely (removes symlink, not target)
 */
/** Called with the bytes of each file as it is removed. */
export type FreedFn = (bytes: number) => void;

/** How many directories are emptied at the same time. */
const REMOVE_WORKERS = 8;

/** Resolves to undefined when the path is already gone, which is what a removal wants. */
function unlessMissing<T>(operation: Promise<T>): Promise<T | undefined> {
  return operation.catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

/**
 * Removes a directory from the inside out, reporting the bytes of each file as it goes,
 * so a long removal can show real progress instead of jumping from nothing to done.
 *
 * Security: never follows a symlink. Links, files and anything that is not a real
 * directory are unlinked; only real directories are listed.
 */
async function removeTree(root: string, onFreed: FreedFn): Promise<void> {
  const pending = [root];
  // Every directory found, parents before children: emptied first, removed at the end.
  const directories: string[] = [];
  let active = 0;
  let failure: unknown;

  const empty = async (dir: string): Promise<void> => {
    // Re-check right before listing: it was a directory when its parent was read.
    const own = await unlessMissing(lstat(dir));
    if (!own) return;
    if (!own.isDirectory()) {
      await unlessMissing(unlink(dir));
      return;
    }

    directories.push(dir);
    for (const entry of (await unlessMissing(readdir(dir, { withFileTypes: true }))) ?? []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }

      const stats = await unlessMissing(lstat(path));
      if (!stats) continue;
      // Some filesystems do not tell the type when listing.
      if (stats.isDirectory()) {
        pending.push(path);
        continue;
      }
      await unlessMissing(unlink(path));
      onFreed(sizeOnDisk(stats));
    }
  };

  await new Promise<void>((done) => {
    const pump = (): void => {
      while (failure === undefined && active < REMOVE_WORKERS && pending.length > 0) {
        active++;
        empty(pending.pop()!)
          .catch((error: unknown) => {
            failure ??= error ?? new Error('removal failed');
          })
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0) done();
    };
    pump();
  });
  if (failure !== undefined) throw failure;

  for (let i = directories.length - 1; i >= 0; i--) {
    await unlessMissing(rmdir(directories[i]));
  }
}

export async function removeItem(path: string, dryRun = false, onFreed?: FreedFn): Promise<boolean> {
  if (dryRun) {
    return true;
  }

  // Security check: validate path is safe to delete
  const safetyError = validatePathSafety(path);
  if (safetyError) {
    console.error(safetyError);
    return false;
  }

  try {
    // Re-check file type immediately before deletion to prevent TOCTOU attacks
    // An attacker could replace a file with a symlink between scan and delete
    const stats = await lstat(path);
    
    if (stats.isSymbolicLink()) {
      // For symlinks, only remove the symlink itself, never follow it
      await unlink(path);
    } else if (!onFreed) {
      await rm(path, { recursive: true, force: true });
    } else if (stats.isDirectory()) {
      await removeTree(path, onFreed);
    } else {
      await unlink(path);
      onFreed(sizeOnDisk(stats));
    }
    return true;
  } catch (error) {
    // Log the error for debugging but don't expose details to potential attackers
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EACCES') {
      console.error(`Failed to remove ${path}: ${code || 'unknown error'}`);
    }
    return false;
  }
}

export async function removeItems(
  items: CleanableItem[],
  dryRun = false,
  onProgress?: (current: number, total: number, item: CleanableItem) => void,
  onFreed?: FreedFn
): Promise<{ success: number; failed: number; freedSpace: number }> {
  let success = 0;
  let failed = 0;
  let freedSpace = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress?.(i + 1, items.length, item);

    const removed = await removeItem(item.path, dryRun, onFreed);
    // A dry run removes nothing, so it reports each item whole.
    if (dryRun) onFreed?.(item.size);
    if (removed) {
      success++;
      freedSpace += item.size;
    } else {
      failed++;
    }
  }

  return { success, failed, freedSpace };
}







