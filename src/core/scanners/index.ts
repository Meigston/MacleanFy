import type { Scanner, CategoryId } from '../types.js';
import { SystemCacheScanner } from './system-cache.js';
import { SystemLogsScanner } from './system-logs.js';
import { TempFilesScanner } from './temp-files.js';
import { TrashScanner } from './trash.js';
import { DownloadsScanner } from './downloads.js';
import { BrowserCacheScanner } from './browser-cache.js';
import { DevCacheScanner } from './dev-cache.js';
import { HomebrewScanner } from './homebrew.js';
import { DockerScanner } from './docker.js';
import { IosBackupsScanner } from './ios-backups.js';
import { MailAttachmentsScanner } from './mail-attachments.js';
import { LanguageFilesScanner } from './language-files.js';
import { LargeFilesScanner } from './large-files.js';
import { NodeModulesScanner } from './node-modules.js';
import { DuplicatesScanner } from './duplicates.js';
import { LaunchAgentsScanner } from './launch-agents.js';
import { AppLeftoversScanner } from './app-leftovers.js';

export const ALL_SCANNERS: Record<CategoryId, Scanner> = {
  'system-cache': new SystemCacheScanner(),
  'system-logs': new SystemLogsScanner(),
  'temp-files': new TempFilesScanner(),
  'trash': new TrashScanner(),
  'downloads': new DownloadsScanner(),
  'browser-cache': new BrowserCacheScanner(),
  'dev-cache': new DevCacheScanner(),
  'homebrew': new HomebrewScanner(),
  'docker': new DockerScanner(),
  'ios-backups': new IosBackupsScanner(),
  'mail-attachments': new MailAttachmentsScanner(),
  'language-files': new LanguageFilesScanner(),
  'large-files': new LargeFilesScanner(),
  'node-modules': new NodeModulesScanner(),
  'duplicates': new DuplicatesScanner(),
  'launch-agents': new LaunchAgentsScanner(),
  'app-leftovers': new AppLeftoversScanner(),
};

export function getScanner(categoryId: CategoryId): Scanner {
  const scanner = ALL_SCANNERS[categoryId];
  if (!scanner) {
    throw new Error(`Unknown scanner category: ${categoryId}`);
  }
  return scanner;
}

export function getAllScanners(): Scanner[] {
  return Object.values(ALL_SCANNERS);
}

export {
  SystemCacheScanner,
  SystemLogsScanner,
  TempFilesScanner,
  TrashScanner,
  DownloadsScanner,
  BrowserCacheScanner,
  DevCacheScanner,
  HomebrewScanner,
  DockerScanner,
  IosBackupsScanner,
  MailAttachmentsScanner,
  LanguageFilesScanner,
  LargeFilesScanner,
  NodeModulesScanner,
  DuplicatesScanner,
  LaunchAgentsScanner,
  AppLeftoversScanner,
};
