import { describe, it, expect, vi } from 'vitest';

vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => '/Users/ana' }));

import type { StartupItemDTO } from '../shared/api';
import {
  STARTUP_FOLDERS,
  describeStartupItem,
  ownerApp,
  parseDisabled,
  parseLaunchctlList,
  parsePlistReadings,
  parseSystemServices,
  sortStartupItems,
  startupWhen,
  type PlistReading,
  type StartupContext,
} from './startup';

const NONE: StartupContext = { overrides: new Map(), running: new Set(), missing: new Set() };

function reading(partial: Partial<PlistReading> = {}): PlistReading {
  return { path: '/Library/LaunchAgents/com.vendor.agent.plist', label: 'com.vendor.agent', ...partial };
}

function item(partial: Partial<StartupItemDTO>): StartupItemDTO {
  return {
    label: 'com.vendor.agent',
    path: '/Library/LaunchAgents/com.vendor.agent.plist',
    scope: 'agent',
    app: null,
    program: null,
    when: 'demand',
    missing: false,
    disabled: false,
    running: false,
    ...partial,
  };
}

describe('startup items', () => {
  it('looks in the three folders launchd loads from', () => {
    expect(STARTUP_FOLDERS).toEqual([
      { scope: 'user', dir: '/Users/ana/Library/LaunchAgents' },
      { scope: 'agent', dir: '/Library/LaunchAgents' },
      { scope: 'daemon', dir: '/Library/LaunchDaemons' },
    ]);
  });

  it('reads what the JXA script prints and drops what it cannot trust', () => {
    const output = JSON.stringify([
      {
        path: '/Library/LaunchAgents/com.logi.optionsplus.plist',
        label: 'com.logi.cp-dev-mgr',
        program: '/Library/Application Support/Logi/agent.app/Contents/MacOS/agent',
        runAtLoad: true,
        keepAlive: ['SuccessfulExit'],
        scheduled: false,
        disabled: false,
        app: '/Library/Application Support/Logi/agent.app',
      },
      { path: '/Users/ana/Library/LaunchAgents/empty.plist' },
      { label: 'no path' },
      { path: '/Library/LaunchDaemons/odd.plist', label: 42, program: '', keepAlive: [1, 'Crashed'] },
    ]);
    expect(parsePlistReadings(output)).toEqual([
      {
        path: '/Library/LaunchAgents/com.logi.optionsplus.plist',
        label: 'com.logi.cp-dev-mgr',
        program: '/Library/Application Support/Logi/agent.app/Contents/MacOS/agent',
        runAtLoad: true,
        keepAlive: ['SuccessfulExit'],
        scheduled: false,
        disabled: false,
        app: '/Library/Application Support/Logi/agent.app',
        unreadable: false,
      },
      {
        path: '/Users/ana/Library/LaunchAgents/empty.plist',
        label: undefined,
        program: undefined,
        runAtLoad: false,
        keepAlive: false,
        scheduled: false,
        disabled: false,
        app: undefined,
        unreadable: false,
      },
      {
        path: '/Library/LaunchDaemons/odd.plist',
        label: undefined,
        program: undefined,
        runAtLoad: false,
        keepAlive: ['Crashed'],
        scheduled: false,
        disabled: false,
        app: undefined,
        unreadable: false,
      },
    ]);
    expect(parsePlistReadings('')).toEqual([]);
    expect(parsePlistReadings('execution error: -1728')).toEqual([]);
    expect(parsePlistReadings('{"path":"/x"}')).toEqual([]);
  });

  it('reads launchd overrides in the new and the old wording', () => {
    const output = [
      'disabled services = {',
      '\t"com.docker.helper" => enabled',
      '\t"com.microsoft.OneDriveMigrationLauncher" => disabled',
      '\t"com.old.style.on" => false',
      '\t"com.old.style.off" => true',
      '}',
    ].join('\n');
    expect(parseDisabled(output)).toEqual(
      new Map([
        ['com.docker.helper', false],
        ['com.microsoft.OneDriveMigrationLauncher', true],
        ['com.old.style.on', false],
        ['com.old.style.off', true],
      ])
    );
  });

  it('knows which agents have a live process', () => {
    const output = [
      'PID\tStatus\tLabel',
      '74136\t0\tcom.lwouis.alt-tab-macos',
      '-\t0\tus.zoom.updater',
      '-\t78\tcom.microsoft.SyncReporter',
    ].join('\n');
    expect(parseLaunchctlList(output)).toEqual(new Set(['com.lwouis.alt-tab-macos']));
  });

  it('knows which system services have a live process', () => {
    const output = [
      'system = {',
      '\ttype = system',
      '\tservices = {',
      '\t\t    4030      - \tcom.parallels.toolbox.EnergySaverHelper',
      '\t\t       0      - \tcom.vix.cron',
      '\t\t     561      - \tcom.docker.vmnetd',
      '\t\t       0      0 \tcom.docker.socket',
      '\t}',
      '\tunmanaged processes = {',
      '\t\t     999      - \tnot.a.service',
      '\t}',
      '}',
    ].join('\n');
    expect(parseSystemServices(output)).toEqual(new Set(['com.parallels.toolbox.EnergySaverHelper', 'com.docker.vmnetd']));
    expect(parseSystemServices('')).toEqual(new Set());
  });

  it('tells when an item runs', () => {
    expect(startupWhen(reading({ runAtLoad: true }))).toBe('load');
    expect(startupWhen(reading({ keepAlive: true }))).toBe('load');
    // SuccessfulExit implica rodar ao carregar; outras condições, não.
    expect(startupWhen(reading({ keepAlive: ['SuccessfulExit'] }))).toBe('load');
    expect(startupWhen(reading({ keepAlive: ['PathState'] }))).toBe('demand');
    expect(startupWhen(reading({ scheduled: true }))).toBe('schedule');
    expect(startupWhen(reading())).toBe('demand');
  });

  it('names the app that owns an item', () => {
    expect(ownerApp(reading({ program: '/Applications/OneDrive.app/Contents/StandaloneUpdater.app/Contents/MacOS/Updater' }))).toBe(
      'OneDrive'
    );
    expect(ownerApp(reading({ program: '/Library/PrivilegedHelperTools/com.docker.vmnetd', app: '/Applications/Docker.app' }))).toBe(
      'Docker'
    );
    expect(ownerApp(reading({ program: '/Users/ana/.wms/printagent/PrintAgent' }))).toBeNull();
  });

  it('describes an item with what launchd says about it', () => {
    const context: StartupContext = {
      overrides: new Map([['com.lwouis.alt-tab-macos', false]]),
      running: new Set(['com.lwouis.alt-tab-macos']),
      missing: new Set(),
    };
    const described = describeStartupItem(
      reading({
        path: '/Users/ana/Library/LaunchAgents/com.lwouis.alt-tab-macos.plist',
        label: 'com.lwouis.alt-tab-macos',
        program: '/Applications/AltTab.app/Contents/MacOS/AltTab',
        runAtLoad: true,
        disabled: true,
      }),
      'user',
      context
    );
    expect(described).toEqual({
      label: 'com.lwouis.alt-tab-macos',
      path: '/Users/ana/Library/LaunchAgents/com.lwouis.alt-tab-macos.plist',
      scope: 'user',
      app: 'AltTab',
      program: '/Applications/AltTab.app/Contents/MacOS/AltTab',
      when: 'load',
      missing: false,
      // O que o launchd guarda por cima vale mais que o plist.
      disabled: false,
      running: true,
    });
  });

  it('flags an item whose program is gone', () => {
    const program = '/Applications/Removed.app/Contents/MacOS/helper';
    const described = describeStartupItem(reading({ program }), 'agent', { ...NONE, missing: new Set([program]) });
    expect(described?.missing).toBe(true);
    expect(described?.app).toBe('Removed');
  });

  it('skips empty plists and anything from Apple', () => {
    expect(describeStartupItem(reading({ label: undefined, program: undefined }), 'user', NONE)).toBeNull();
    expect(describeStartupItem(reading({ label: 'com.apple.something', program: '/usr/libexec/x' }), 'daemon', NONE)).toBeNull();
  });

  it('still lists a plist only root can read, by its file name', () => {
    const described = describeStartupItem(
      { path: '/Library/LaunchDaemons/com.nordvpn.macos.helper.plist', unreadable: true },
      'daemon',
      { ...NONE, running: new Set(['com.nordvpn.macos.helper']) }
    );
    expect(described).toMatchObject({ label: 'com.nordvpn.macos.helper', when: 'unknown', running: true, missing: false });
  });

  it('falls back to the file name when the plist has no label', () => {
    const described = describeStartupItem(
      reading({ path: '/Library/LaunchDaemons/com.vendor.helper.plist', label: undefined, program: '/usr/local/bin/helper' }),
      'daemon',
      NONE
    );
    expect(described?.label).toBe('com.vendor.helper');
  });

  it('puts broken items first, then what opens on its own', () => {
    const sorted = sortStartupItems([
      item({ label: 'd', when: 'unknown' }),
      item({ label: 'c', when: 'demand' }),
      item({ label: 'b', when: 'schedule' }),
      item({ label: 'z', app: 'Zoom', when: 'load' }),
      item({ label: 'a', app: 'AltTab', when: 'load' }),
      item({ label: 'x', when: 'demand', missing: true }),
    ]);
    expect(sorted.map((entry) => entry.label)).toEqual(['x', 'a', 'z', 'b', 'c', 'd']);
  });
});
