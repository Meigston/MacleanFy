import { describe, it, expect, vi } from 'vitest';

vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => '/Users/ana' }));

import type { StartupItemDTO } from '../shared/api';
import {
  STARTUP_FOLDERS,
  describeHelper,
  describeStartupItem,
  helperCandidates,
  isLoginHelper,
  isToggleable,
  outermostApp,
  ownerApp,
  parseAppPaths,
  parseDisabled,
  parseLaunchctlList,
  parsePlistReadings,
  parseServiceLabels,
  parseServicePrint,
  parseSystemServices,
  sortStartupItems,
  startupWhen,
  type PlistReading,
  type ServiceInfo,
  type StartupContext,
} from './startup';

const NONE: StartupContext = { overrides: new Map(), running: new Set(), missing: new Set() };

function reading(partial: Partial<PlistReading> = {}): PlistReading {
  return { path: '/Library/LaunchAgents/com.vendor.agent.plist', label: 'com.vendor.agent', ...partial };
}

function item(partial: Partial<StartupItemDTO>): StartupItemDTO {
  return {
    id: '/Library/LaunchAgents/com.vendor.agent.plist',
    label: 'com.vendor.agent',
    path: '/Library/LaunchAgents/com.vendor.agent.plist',
    scope: 'agent',
    app: null,
    program: null,
    when: 'demand',
    missing: false,
    disabled: false,
    running: false,
    toggleable: false,
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
        bundleIds: ['com.logi.cp-dev-mgr', 7],
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
        bundleIds: ['com.logi.cp-dev-mgr'],
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
        bundleIds: [],
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
        bundleIds: [],
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
      id: '/Users/ana/Library/LaunchAgents/com.lwouis.alt-tab-macos.plist',
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
      toggleable: true,
    });
  });

  it('turns on and off only what loads in your session and opens on its own', () => {
    expect(isToggleable({ scope: 'user', when: 'load', disabled: false })).toBe(true);
    expect(isToggleable({ scope: 'agent', when: 'schedule', disabled: false })).toBe(true);
    expect(isToggleable({ scope: 'helper', when: 'load', disabled: true })).toBe(true);
    // Serviço do sistema pede a senha: fica com os Ajustes.
    expect(isToggleable({ scope: 'daemon', when: 'load', disabled: false })).toBe(false);
    // Só o root lê o plist: o rótulo vem do nome do arquivo e pode não ser o de verdade.
    expect(isToggleable({ scope: 'user', when: 'unknown', disabled: false })).toBe(false);
    // Quando chamado não abre sozinho; desligar só quebraria quem chama. Desligado, volta.
    expect(isToggleable({ scope: 'user', when: 'demand', disabled: false })).toBe(false);
    expect(isToggleable({ scope: 'user', when: 'demand', disabled: true })).toBe(true);
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

  describe('login helpers', () => {
    const SESSION = [
      'com.apple.xpc.launchd.domain.user.501 = {',
      '\ttype = login',
      '\tservices = {',
      '\t\t   7784      - \tcom.lwouis.alt-tab-macos',
      '\t\t      0      0 \tcom.spotify.client.startuphelper',
      '\t\t   8574      - \tapplication.com.zzd.Xnip.2925543.2925724',
      '\t\t      0      0 \tcom.apple.Siri.agent',
      '\t}',
      '',
      '\tunmanaged processes = {',
      '\t\t   901      - \t0x7f8c',
      '\t}',
    ].join('\n');

    it('reads every service label of a session, running or not', () => {
      expect(parseServiceLabels(SESSION)).toEqual([
        'com.lwouis.alt-tab-macos',
        'com.spotify.client.startuphelper',
        'application.com.zzd.Xnip.2925543.2925724',
        'com.apple.Siri.agent',
      ]);
      expect(parseServiceLabels('')).toEqual([]);
    });

    it('reads who submitted a service and for which app', () => {
      const helper = parseServicePrint(
        [
          'gui/501/com.spotify.client.startuphelper = {',
          '\tactive count = 0',
          '\tpath = (submitted by smd.330)',
          '\ttype = Submitted',
          '\tstate = not running',
          '\tprogram identifier = com.spotify.client.startuphelper (mode: 1)',
          '\tparent bundle identifier = com.spotify.client',
          '}',
        ].join('\n')
      );
      expect(helper).toEqual({ submittedBy: 'smd', plist: null, parent: 'com.spotify.client', running: false, runAtLoad: false });

      const agent = parseServicePrint(
        [
          'gui/501/com.logi.cp-dev-mgr = {',
          '\tpath = /Library/LaunchAgents/com.logi.optionsplus.plist',
          '\tstate = running',
          '\tproperties = partial import | keepalive | runatload | inferred program',
          '}',
        ].join('\n')
      );
      expect(agent).toEqual({
        submittedBy: null,
        plist: '/Library/LaunchAgents/com.logi.optionsplus.plist',
        parent: null,
        running: true,
        runAtLoad: true,
      });

      // Fora do launchd, o print falha e não sobra nada.
      expect(parseServicePrint('')).toBeNull();
    });

    it('tells a login helper from anything else launchd runs', () => {
      const info = (partial: Partial<ServiceInfo>): ServiceInfo => ({
        submittedBy: null,
        plist: null,
        parent: null,
        running: false,
        runAtLoad: false,
        ...partial,
      });
      expect(isLoginHelper(info({ submittedBy: 'smd' }))).toBe(true);
      expect(isLoginHelper(info({ plist: '/Applications/Vendor.app/Contents/Library/LaunchAgents/com.vendor.agent.plist' }))).toBe(true);
      // O ShipIt é o atualizador do próprio app, cadastrado por ele enquanto roda.
      expect(isLoginHelper(info({ submittedBy: 'Granola' }))).toBe(false);
      expect(isLoginHelper(info({ plist: '/System/Library/LaunchAgents/com.openssh.ssh-agent.plist' }))).toBe(false);
    });

    it('looks only at labels that are not plists, apps or Apple', () => {
      const labels = [...parseServiceLabels(SESSION), 'com.spotify.client.startuphelper', 'com.docker.helper', '0x7f8c'];
      expect(helperCandidates(labels, new Set(['com.lwouis.alt-tab-macos']))).toEqual([
        'com.spotify.client.startuphelper',
        'com.docker.helper',
      ]);
    });

    it('names the app outside a path', () => {
      expect(outermostApp('/Applications/Spotify.app/Contents/Library/LoginItems/StartUpHelper.app')).toBe('Spotify');
      expect(outermostApp('/Applications/macOS InstantView.app')).toBe('macOS InstantView');
      expect(outermostApp('/usr/local/bin/tool')).toBeNull();
    });

    it('reads where macOS finds each app and drops the rest', () => {
      expect(parseAppPaths('{"com.a":"/Applications/A.app","com.b":3,"com.c":"relative"}')).toEqual({ 'com.a': '/Applications/A.app' });
      expect(parseAppPaths('[]')).toEqual({});
      expect(parseAppPaths('nope')).toEqual({});
    });

    const SPOTIFY_HELPER = '/Applications/Spotify.app/Contents/Library/LoginItems/StartUpHelper.app';
    const APPS = { 'com.spotify.client.startuphelper': SPOTIFY_HELPER, 'com.spotify.client': '/Applications/Spotify.app' };
    const SMD: ServiceInfo = { submittedBy: 'smd', plist: null, parent: 'com.spotify.client', running: false, runAtLoad: false };

    it('describes a helper registered by its app', () => {
      expect(describeHelper('com.spotify.client.startuphelper', SMD, false, APPS)).toEqual({
        id: 'helper:com.spotify.client.startuphelper',
        label: 'com.spotify.client.startuphelper',
        path: SPOTIFY_HELPER,
        scope: 'helper',
        app: 'Spotify',
        program: SPOTIFY_HELPER,
        when: 'load',
        missing: false,
        disabled: false,
        running: false,
        toggleable: true,
      });
    });

    it('keeps a helper turned off, as long as its app is still there', () => {
      expect(describeHelper('com.spotify.client.startuphelper', null, true, APPS)).toMatchObject({ disabled: true, toggleable: true });
      // Cadastro antigo de um app que não tem mais o ajudante: não abre nada.
      expect(describeHelper('com.openai.chat-helper', null, true, APPS)).toBeNull();
      // Ligado na lista e fora do launchd: não se sabe se abre, e não aparece como se abrisse.
      expect(describeHelper('com.spotify.client.startuphelper', null, false, APPS)).toBeNull();
    });

    it('lets an agent inside an app open on its own only when its plist says so', () => {
      const plist = '/Applications/Vendor.app/Contents/Library/LaunchAgents/com.vendor.xpc.plist';
      const service: ServiceInfo = { submittedBy: null, plist, parent: null, running: false, runAtLoad: false };
      expect(describeHelper('com.vendor.xpc', service, undefined, {})).toMatchObject({
        path: plist,
        app: 'Vendor',
        when: 'demand',
        toggleable: false,
      });
      expect(describeHelper('com.vendor.xpc', { ...service, runAtLoad: true }, undefined, {})).toMatchObject({
        when: 'load',
        toggleable: true,
      });
    });

    it('keeps two helpers of the same app apart', () => {
      const one = describeHelper('com.vendor.one', { ...SMD, parent: 'com.spotify.client' }, undefined, APPS);
      const two = describeHelper('com.vendor.two', { ...SMD, parent: 'com.spotify.client' }, undefined, APPS);
      expect(one?.path).toBe(two?.path);
      expect(one?.id).not.toBe(two?.id);
    });

    it('falls back to the parent app when the helper bundle is not found', () => {
      const described = describeHelper('com.vendor.helper', { ...SMD, parent: 'com.spotify.client' }, undefined, APPS);
      expect(described).toMatchObject({ path: '/Applications/Spotify.app', app: 'Spotify', program: null });
    });

    it('skips services that are not login helpers', () => {
      expect(describeHelper('com.granola.app.ShipIt', { ...SMD, submittedBy: 'Granola', parent: null }, undefined, APPS)).toBeNull();
    });
  });
});
