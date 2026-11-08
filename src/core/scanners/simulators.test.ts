import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exists } from '../utils/fs.js';
import {
  SimulatorsScanner,
  androidDetail,
  bootedSimulators,
  deviceTypeName,
  locateSimctl,
  parseIni,
  parsePlist,
  parseSimctlDevices,
  runningEmulators,
  runtimeName,
  sameModel,
  type Simctl,
} from './simulators.js';

const SIMCTL = '/fake/CoreSimulator.framework/Versions/A/Resources/bin/simctl';
const XCODE = '/fake/Xcode.app/Contents/Developer';
const OPEN = 'A0000000-0000-4000-8000-000000000001';
const OLD = 'B0000000-0000-4000-8000-000000000002';
const IDLE = 'C0000000-0000-4000-8000-000000000003';
const GONE = 'D0000000-0000-4000-8000-000000000004';
const LOOSE = 'E0000000-0000-4000-8000-000000000005';

function plist(fields: Record<string, string | number | boolean>, extra = ''): string {
  const body = Object.entries(fields)
    .map(([key, value]) => {
      if (typeof value === 'boolean') return `<key>${key}</key><${value}/>`;
      if (typeof value === 'number') return `<key>${key}</key><integer>${value}</integer>`;
      if (key === 'lastBootedAt') return `<key>${key}</key><date>${value}</date>`;
      return `<key>${key}</key><string>${value}</string>`;
    })
    .join('\n\t');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t${body}${extra}
</dict>
</plist>
`;
}

describe('reading what Xcode and Android Studio leave on disk', () => {
  it('reads the top-level keys of a device.plist and skips nested ones', () => {
    const xml = plist(
      { UDID: OPEN, name: 'Ana &amp; Bia', state: 3, isDeleted: false, lastBootedAt: '2026-11-08T10:14:34Z' },
      '\n\t<key>prefs</key><dict><key>name</key><string>nested</string><key>deep</key><array><dict><key>state</key><integer>9</integer></dict></array></dict>\n\t<key>empty</key><string/>'
    );
    expect(parsePlist(xml)).toEqual({
      UDID: OPEN,
      name: 'Ana & Bia',
      state: 3,
      isDeleted: false,
      lastBootedAt: '2026-11-08T10:14:34Z',
      empty: '',
    });
    expect(parsePlist('not a plist')).toEqual({});
  });

  it('turns identifiers into names people know', () => {
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.iOS-26-2')).toBe('iOS 26.2');
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.watchOS-11-0')).toBe('watchOS 11.0');
    expect(runtimeName('com.apple.CoreSimulator.SimRuntime.xrOS-2-0')).toBe('visionOS 2.0');
    expect(runtimeName('something else')).toBe('');
    expect(deviceTypeName('com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro')).toBe('iPhone 17 Pro');
  });

  it('only adds the model when the name does not already say it', () => {
    expect(sameModel('iPad Pro 11-inch (M4)', 'iPad Pro 11 inch M4 8GB')).toBe(true);
    expect(sameModel('iPhone SE (3rd generation)', 'iPhone SE 3rd generation')).toBe(true);
    expect(sameModel('iPhone Bancada B', 'iPhone 17 Pro')).toBe(false);
    expect(sameModel('Anything', '')).toBe(true);
  });

  it('describes an AVD by its Android version, API level and image', () => {
    const config = parseIni(
      'avd.ini.displayname=Pixel 9 API 35\nimage.sysdir.1=system-images/android-35/google_apis_playstore/arm64-v8a/\ntag.display=Google Play\n# comment=no\n'
    );
    expect(config['avd.ini.displayname']).toBe('Pixel 9 API 35');
    expect(config['# comment']).toBeUndefined();
    expect(androidDetail(config)).toBe('Android 15 · API 35 · Google Play');
    expect(androidDetail({ target: 'android-36.1', 'tag.display': 'Default' })).toBe('Android 16 · API 36.1');
    expect(androidDetail({ target: 'android-99' })).toBe('API 99');
    expect(androidDetail({})).toBe('');
  });

  it('reads simctl and tells a broken answer from an empty one', () => {
    const devices = parseSimctlDevices(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [{ udid: OPEN.toLowerCase(), isAvailable: true, state: 'Booted' }],
          'com.apple.CoreSimulator.SimRuntime.iOS-18-3': [{ udid: OLD, isAvailable: false, state: 'Shutdown' }],
        },
      })
    );
    expect(devices?.get(OPEN)).toEqual({ available: true, state: 'Booted' });
    expect(devices?.get(OLD)).toEqual({ available: false, state: 'Shutdown' });
    expect(parseSimctlDevices('{"devices":{}}')?.size).toBe(0);
    expect(parseSimctlDevices('nope')).toBeNull();
    expect(parseSimctlDevices(null)).toBeNull();
  });

  it('finds what is running in the process list', () => {
    const ps = [
      `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim /Users/ana/Library/Developer/CoreSimulator/Devices/${OPEN}/data/var/run/launchd_bootstrap.plist`,
      `/usr/bin/du -sk /Users/ana/Library/Developer/CoreSimulator/Devices/${IDLE}/data`,
      '/Users/ana/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -netdelay none -avd Pixel_9_API_35 -port 5554',
      '/Users/ana/Library/Android/sdk/emulator/emulator @Pixel_7',
      'node cap run android --target emulator-5556 -avd Not_This_One',
    ].join('\n');
    expect([...bootedSimulators(ps)]).toEqual([OPEN]);
    expect([...runningEmulators(ps)].sort()).toEqual(['Pixel_7', 'Pixel_9_API_35']);
  });
});

describe('locateSimctl', () => {
  let dir: string;
  const calls: string[][] = [];
  const runner = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    return null;
  };

  async function executable(path: string, content: string | Buffer) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
    await chmod(path, 0o755);
  }

  /** Um Xcode com o script de verdade na frente do simctl, esperando o CoreSimulator `expected`. */
  async function xcode(name: string, expected: string, installed: string) {
    const framework = join(dir, `${name}-fw`, 'CoreSimulator.framework', 'Versions', 'A');
    const binary = join(framework, 'Resources', 'bin', 'simctl');
    await executable(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
    await writeFile(join(framework, 'Resources', 'Info.plist'), plist({ CFBundleVersion: installed }));
    const developer = join(dir, `${name}.app`, 'Contents', 'Developer');
    await executable(
      join(developer, 'usr', 'bin', 'simctl'),
      `#!/bin/bash\nEXPECTED_VERSION="${expected}"\nif [[ "\${EXPECTED_VERSION}" != "\${CURRENT_VERSION}" ]]; then\n    "\${DEVELOPER_DIR}/usr/bin/xcodebuild" -runFirstLaunch >&2\nfi\nexec "${binary}" "\${@}"\n`
    );
    return { developer, binary };
  }

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'simctl-test-')));
    calls.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('calls the binary behind the script when the versions match', async () => {
    const { developer, binary } = await xcode('Xcode', '1051.17.7', '1051.17.7');
    expect(await locateSimctl([developer], runner)).toEqual({ path: binary, developerDir: developer });
    expect(calls).toEqual([]);
  });

  it('runs nothing while Xcode waits for its first launch', async () => {
    const { developer } = await xcode('Xcode', '1051.17.7', '1051.12.1');
    expect(await locateSimctl([developer], runner)).toBe('blocked');
    expect(calls).toEqual([]);
  });

  it('uses an older Xcode whose simctl is the binary itself', async () => {
    const developer = join(dir, 'Old.app', 'Contents', 'Developer');
    await executable(join(developer, 'usr', 'bin', 'simctl'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    expect(await locateSimctl([undefined, 'relative/path', developer], runner)).toEqual({
      path: join(developer, 'usr', 'bin', 'simctl'),
      developerDir: developer,
    });
  });

  it('finds nothing where there is no Xcode', async () => {
    expect(await locateSimctl([join(dir, 'CommandLineTools'), undefined], runner)).toBeNull();
  });
});

describe('SimulatorsScanner', () => {
  let dir: string;
  let home: string;
  let devices: string;
  let avd: string;
  let sdk: string;
  let state: {
    ps: string | null;
    simctl: Record<string, Array<Record<string, unknown>>>;
    calls: string[][];
    developerDirs: Array<string | undefined>;
  };

  const runner = async (command: string, args: string[], env?: Record<string, string>): Promise<string | null> => {
    state.calls.push([command, ...args]);
    if (command === '/bin/ps') return state.ps;
    if (command !== SIMCTL) return null;
    state.developerDirs.push(env?.DEVELOPER_DIR);
    if (args[0] === 'list') return JSON.stringify({ devices: state.simctl });
    if (args[0] === 'delete') {
      await rm(join(devices, args[1]), { recursive: true, force: true });
      return '';
    }
    return null;
  };

  const scanner = (simctl: Simctl = { path: SIMCTL, developerDir: XCODE }) =>
    new SimulatorsScanner({ home, env: {}, run: runner, simctl });

  async function simulator(udid: string, fields: Record<string, string | number | boolean>, bytes = 1000) {
    await mkdir(join(devices, udid, 'data'), { recursive: true });
    await writeFile(join(devices, udid, 'device.plist'), plist({ UDID: udid, isDeleted: false, ...fields }));
    await writeFile(join(devices, udid, 'data', 'blob'), Buffer.alloc(bytes, 1));
  }

  async function emulator(name: string, config: string, ini = true) {
    await mkdir(join(avd, `${name}.avd`), { recursive: true });
    await writeFile(join(avd, `${name}.avd`, 'config.ini'), config);
    await writeFile(join(avd, `${name}.avd`, 'userdata-qemu.img'), Buffer.alloc(5000, 1));
    if (ini) await writeFile(join(avd, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${join(avd, `${name}.avd`)}\npath.rel=avd/${name}.avd\n`);
  }

  beforeEach(async () => {
    // /var é link para /private/var; o scanner devolve o caminho já resolvido.
    dir = await realpath(await mkdtemp(join(tmpdir(), 'simulators-test-')));
    home = join(dir, 'home');
    devices = join(home, 'Library', 'Developer', 'CoreSimulator', 'Devices');
    avd = join(home, '.android', 'avd');
    sdk = join(home, 'Library', 'Android', 'sdk');
    state = { ps: '', simctl: {}, calls: [], developerDirs: [] };
    await mkdir(devices, { recursive: true });
    await mkdir(avd, { recursive: true });
    await mkdir(join(sdk, 'system-images', 'android-35', 'google_apis_playstore', 'arm64-v8a'), { recursive: true });

    await simulator(OPEN, {
      name: 'iPhone 17 Pro',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
      state: 3,
      lastBootedAt: '2026-11-08T10:14:34Z',
    });
    await simulator(OLD, {
      name: 'iPhone Bancada B',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-3',
      state: 1,
    }, 4000);
    await simulator(IDLE, {
      name: 'iPad Pro 11-inch (M4)',
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
      state: 1,
    });
    await simulator(GONE, { name: 'Deleted', isDeleted: true, state: 1 });
    // Pasta sem device.plist e pasta que não é UDID: nada que dê para identificar.
    await mkdir(join(devices, LOOSE, 'data'), { recursive: true });
    await writeFile(join(devices, 'device_set.plist'), plist({}));

    state.simctl = {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
        { udid: OPEN, isAvailable: true, state: 'Shutdown' },
        { udid: IDLE, isAvailable: true, state: 'Shutdown' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-18-3': [{ udid: OLD, isAvailable: false, state: 'Shutdown' }],
    };
    state.ps = `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/bin/launchd_sim ${devices}/${OPEN}/data/var/run/launchd_bootstrap.plist`;

    await emulator(
      'Pixel_9_API_35',
      'avd.ini.displayname=Pixel 9 API 35\nimage.sysdir.1=system-images/android-35/google_apis_playstore/arm64-v8a/\ntag.display=Google Play\n'
    );
    await writeFile(join(avd, 'Pixel_9_API_35.avd', 'hardware-qemu.ini'), 'x');
    await emulator('Old_Tablet', 'image.sysdir.1=system-images/android-30/google_apis/arm64-v8a/\n');
    await emulator('Leftover', 'image.sysdir.1=system-images/android-35/google_apis_playstore/arm64-v8a/\n', false);
    // Um .ini que aponta para fora de um AVD nunca entra na lista, e nada ali é apagado.
    await mkdir(join(home, 'Documents', 'Projects'), { recursive: true });
    await writeFile(join(home, 'Documents', 'Projects', 'config.ini'), 'x');
    await writeFile(join(avd, 'Evil.ini'), `path=${join(home, 'Documents', 'Projects')}\npath.rel=../Documents/Projects\n`);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('belongs to the Development group and is never ticked by default', () => {
    expect(scanner().category.id).toBe('simulators');
    expect(scanner().category.group).toBe('Development');
    expect(scanner().category.safetyLevel).toBe('moderate');
  });

  it('lists each simulator and emulator with its size, system and state', async () => {
    const result = await scanner().scan();
    const byName = Object.fromEntries(result.items.map((item) => [item.name, item]));
    expect(Object.keys(byName).sort()).toEqual([
      'Leftover',
      'Old Tablet',
      'Pixel 9 API 35',
      'iPad Pro 11-inch (M4)',
      'iPhone 17 Pro',
      'iPhone Bancada B',
    ]);

    expect(byName['iPhone 17 Pro']).toMatchObject({
      path: join(devices, OPEN),
      detail: 'iOS 26.3',
      flags: ['running'],
      usedAt: new Date('2026-11-08T10:14:34Z'),
    });
    expect(byName['iPhone 17 Pro'].size).toBeGreaterThanOrEqual(1000);
    expect(byName['iPhone Bancada B']).toMatchObject({ detail: 'iPhone 16 · iOS 18.3', flags: ['unavailable'] });
    expect(byName['iPhone Bancada B'].size).toBeGreaterThanOrEqual(4000);
    expect(byName['iPad Pro 11-inch (M4)']).toMatchObject({ detail: 'iOS 26.3', flags: [] });
    expect(byName['iPad Pro 11-inch (M4)'].usedAt).toBeUndefined();

    expect(byName['Pixel 9 API 35']).toMatchObject({
      path: join(avd, 'Pixel_9_API_35.avd'),
      detail: 'Android 15 · API 35 · Google Play',
      flags: [],
    });
    expect(byName['Pixel 9 API 35'].usedAt).toBeInstanceOf(Date);
    expect(byName['Pixel 9 API 35'].size).toBeGreaterThanOrEqual(5000);
    // Sem a imagem do sistema no SDK, ou sem o .ini que o Android Studio lê, ele não abre mais.
    expect(byName['Old Tablet']).toMatchObject({ detail: 'Android 11 · API 30', flags: ['unavailable'] });
    expect(byName['Leftover'].flags).toEqual(['unavailable']);
    expect(result.totalSize).toBe(result.items.reduce((sum, item) => sum + item.size, 0));
  });

  it('flags a running emulator', async () => {
    state.ps = '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_9_API_35 -port 5554';
    const result = await scanner().scan();
    expect(result.items.find((item) => item.name === 'Pixel 9 API 35')?.flags).toEqual(['running']);
    expect(result.items.find((item) => item.name === 'iPhone 17 Pro')?.flags).toEqual([]);
  });

  it('flags nothing as unavailable when there is no simctl to ask', async () => {
    const result = await scanner(null).scan();
    const ios = result.items.filter((item) => item.path.startsWith(devices));
    // O launchd_sim no ps diz qual está ligado.
    expect(ios.map((item) => [item.name, item.flags])).toEqual(
      expect.arrayContaining([
        ['iPhone 17 Pro', ['running']],
        ['iPhone Bancada B', []],
        ['iPad Pro 11-inch (M4)', []],
      ])
    );
    expect(state.calls.some(([command]) => command === SIMCTL)).toBe(false);
  });

  it('does not trust the state saved in device.plist', async () => {
    // O device.plist do iPhone 17 Pro diz state 3 (ligado), mas nada roda e o simctl diz desligado.
    state.ps = '';
    for (const simctl of [null, { path: SIMCTL, developerDir: XCODE }] as Simctl[]) {
      const result = await scanner(simctl).scan();
      expect(result.items.find((item) => item.name === 'iPhone 17 Pro')?.flags).toEqual([]);
    }
  });

  it('asks simctl with the Xcode it belongs to', async () => {
    await scanner().scan();
    expect(state.developerDirs).toEqual([XCODE]);
  });

  it('lists but never deletes simulators while Xcode waits for its first launch', async () => {
    state.ps = '';
    const sims = scanner('blocked');
    const { items } = await sims.scan();
    expect(items.find((item) => item.name === 'iPhone Bancada B')?.flags).toEqual([]);
    const pick = items.filter((item) => ['iPhone Bancada B', 'Old Tablet'].includes(item.name));

    const result = await sims.clean(pick);
    expect(result.cleanedItems).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(await exists(join(devices, OLD))).toBe(true);
    expect(await exists(join(avd, 'Old_Tablet.avd'))).toBe(false);
    expect(state.calls.some(([command]) => command === SIMCTL)).toBe(false);
  });

  it('deletes nothing when the process list cannot be read', async () => {
    state.ps = '';
    const sims = scanner();
    const { items } = await sims.scan();
    state.ps = null;
    const result = await sims.clean(items.filter((item) => ['iPhone Bancada B', 'Old Tablet'].includes(item.name)));
    expect(result.cleanedItems).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(await exists(join(devices, OLD))).toBe(true);
    expect(await exists(join(avd, 'Old_Tablet.avd'))).toBe(true);
  });

  it('finds nothing on a Mac without Xcode or Android Studio', async () => {
    const empty = new SimulatorsScanner({ home: join(dir, 'nobody'), env: {}, run: runner, simctl: null });
    expect((await empty.scan()).items).toEqual([]);
  });

  it('reads the AVD folder from ANDROID_AVD_HOME', async () => {
    const elsewhere = new SimulatorsScanner({ home: join(dir, 'nobody'), env: { ANDROID_AVD_HOME: avd }, run: runner, simctl: null });
    expect((await elsewhere.scan()).items.map((item) => item.name).sort()).toEqual(['Leftover', 'Old Tablet', 'Pixel 9 API 35']);
  });

  it('does nothing on a dry run', async () => {
    const sims = scanner();
    const { items } = await sims.scan();
    const result = await sims.clean(items, true);
    expect(result.cleanedItems).toBe(items.length);
    expect(await exists(join(devices, OLD))).toBe(true);
    expect(state.calls.some(([, action]) => action === 'delete')).toBe(false);
  });

  it('deletes simulators through simctl and emulators with their .ini', async () => {
    state.ps = '';
    const sims = scanner();
    const { items } = await sims.scan();
    const pick = items.filter((item) => ['iPhone Bancada B', 'Old Tablet', 'Leftover'].includes(item.name));
    const freed: number[] = [];

    const result = await sims.clean(pick, false, (bytes) => freed.push(bytes));
    expect(result).toMatchObject({ cleanedItems: 3, errors: [] });
    expect(result.freedSpace).toBe(pick.reduce((sum, item) => sum + item.size, 0));
    expect(freed.reduce((sum, bytes) => sum + bytes, 0)).toBe(result.freedSpace);
    expect(state.calls).toContainEqual([SIMCTL, 'delete', OLD]);
    expect(await exists(join(devices, OLD))).toBe(false);
    expect(await exists(join(avd, 'Old_Tablet.avd'))).toBe(false);
    expect(await exists(join(avd, 'Old_Tablet.ini'))).toBe(false);
    expect(await exists(join(avd, 'Leftover.avd'))).toBe(false);
    // O resto fica, e o que o .ini malicioso apontava também.
    expect(await exists(join(devices, IDLE))).toBe(true);
    expect(await exists(join(avd, 'Pixel_9_API_35.avd'))).toBe(true);
    expect(await exists(join(home, 'Documents', 'Projects', 'config.ini'))).toBe(true);
  });

  it('removes the folder of a simulator simctl does not know', async () => {
    state.ps = '';
    delete state.simctl['com.apple.CoreSimulator.SimRuntime.iOS-18-3'];
    const sims = scanner();
    const { items } = await sims.scan();
    const orphan = items.find((item) => item.name === 'iPhone Bancada B')!;
    expect(orphan.flags).toEqual(['unavailable']);
    expect((await sims.clean([orphan])).cleanedItems).toBe(1);
    expect(state.calls.some(([, action]) => action === 'delete')).toBe(false);
    expect(await exists(join(devices, OLD))).toBe(false);
  });

  it('keeps a simulator when simctl is there but does not answer', async () => {
    state.ps = '';
    const sims = scanner();
    const { items } = await sims.scan();
    const old = items.find((item) => item.name === 'iPhone Bancada B')!;
    const failing = async (command: string, args: string[]) =>
      command === SIMCTL && args[0] === 'list' ? null : runner(command, args);
    const stuck = new SimulatorsScanner({ home, env: {}, run: failing, simctl: { path: SIMCTL, developerDir: XCODE } });
    await stuck.scan();
    const result = await stuck.clean([old]);
    expect(result.cleanedItems).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(await exists(join(devices, OLD))).toBe(true);
  });

  it('takes an AVD registered twice as one, open under either name', async () => {
    await symlink(avd, join(home, 'avd-link'));
    await writeFile(join(avd, 'Twin.ini'), `path=${join(home, 'avd-link', 'Pixel_9_API_35.avd')}\n`);
    state.ps = '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Twin';
    const sims = scanner();
    const { items } = await sims.scan();
    const twins = items.filter((item) => item.name === 'Pixel 9 API 35');
    expect(twins).toHaveLength(1);
    expect(twins[0].flags).toEqual(['running']);
    expect((await sims.clean(twins)).cleanedItems).toBe(0);

    state.ps = '';
    expect((await sims.clean(twins)).cleanedItems).toBe(1);
    expect(await exists(join(avd, 'Pixel_9_API_35.avd'))).toBe(false);
    expect(await exists(join(avd, 'Pixel_9_API_35.ini'))).toBe(false);
    expect(await exists(join(avd, 'Twin.ini'))).toBe(false);
  });

  it('keeps anything that was opened after the scan', async () => {
    state.ps = '';
    const sims = scanner();
    const { items } = await sims.scan();
    state.ps = [
      `/x/launchd_sim ${devices}/${IDLE}/data/var/run/launchd_bootstrap.plist`,
      '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_9_API_35',
    ].join('\n');
    const pick = items.filter((item) => ['iPad Pro 11-inch (M4)', 'Pixel 9 API 35'].includes(item.name));

    const result = await sims.clean(pick);
    expect(result.cleanedItems).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(await exists(join(devices, IDLE))).toBe(true);
    expect(await exists(join(avd, 'Pixel_9_API_35.avd'))).toBe(true);
  });

  it('ignores anything the last scan did not list', async () => {
    const sims = scanner();
    await sims.scan();
    const result = await sims.clean([
      { path: join(home, 'Documents', 'Projects'), name: 'Projects', size: 1, isDirectory: true },
    ]);
    expect(result.cleanedItems).toBe(0);
    expect(await exists(join(home, 'Documents', 'Projects'))).toBe(true);
  });
});
