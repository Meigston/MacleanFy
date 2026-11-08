import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { WHOLE_SEGMENTS, type HomeShareDTO, type WholeDiskDTO, type WholeSegmentId } from '../shared/api';
import { parseDuLine } from './disk';
import { parseFirmlinks, type ApfsContainer, type ApfsVolume } from './volume';
import {
  DATA_ROOT,
  DEFAULT_FIRMLINKS,
  HOME_RULES,
  assemble,
  carveHome,
  classifyOutside,
  classifyTop,
  isStale,
  outsideCarves,
  outsideOperands,
  userVarFolder,
  visiblePath,
  wholeOptions,
  type AssembleInput,
  type TopEntry,
} from './whole-disk';

const D = DATA_ROOT;
const KIB = 1024;
const isUnder = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');

/** O mapa de tamanhos como o du -k o imprime: cada linha passa pelo mesmo leitor que a medida usa. */
function duSizes(rows: ReadonlyArray<readonly [string, number]>, root: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const [relative, kib] of rows) {
    const entry = parseDuLine(`${kib}\t${relative ? join(root, relative) : root}`);
    if (!entry) throw new Error(`linha de du inválida: ${relative}`);
    sizes.set(entry.path, entry.size);
  }
  return sizes;
}

const dir = (name: string, extra: Partial<TopEntry> = {}): TopEntry => ({
  name,
  sameDevice: true,
  symlink: false,
  directory: true,
  ...extra,
});

// ---------------------------------------------------------------------------
// Fora da pasta pessoal
// ---------------------------------------------------------------------------

describe('classifyTop', () => {
  it('skips mount points and autofs', () => {
    expect(classifyTop('Volumes')).toBe('skip');
    expect(classifyTop('home')).toBe('skip');
    expect(classifyTop('Network')).toBe('skip');
  });

  it('sends the known folders to their segments', () => {
    expect(classifyTop('Applications')).toBe('apps');
    expect(classifyTop('Library')).toBe('apps');
    expect(classifyTop('opt')).toBe('dev');
    expect(classifyTop('sw')).toBe('dev');
    expect(classifyTop('usr')).toBe('dev');
    expect(classifyTop('private')).toBe('system-data');
    expect(classifyTop('System')).toBe('system-data');
    expect(classifyTop('Users')).toBe('users');
  });

  it('treats an unknown folder as the system’s, never as something to clean', () => {
    expect(classifyTop('MobileSoftwareUpdate')).toBe('system-data');
    expect(classifyTop('cores')).toBe('system-data');
    // Nomes que existem no protótipo de um objeto não podem enganar a tabela.
    expect(classifyTop('constructor')).toBe('system-data');
    expect(classifyTop('toString')).toBe('system-data');
    expect(classifyTop('__proto__')).toBe('system-data');
  });

  it('skips unknown hidden folders, but keeps the hidden ones the system owns', () => {
    expect(classifyTop('.Spotlight-V100')).toBe('skip');
    expect(classifyTop('.fseventsd')).toBe('skip');
    expect(classifyTop('.DocumentRevisions-V100')).toBe('skip');
    expect(classifyTop('.PreviousSystemInformation')).toBe('system-data');
    expect(classifyTop('.com.apple.templatemigration.boot-install')).toBe('system-data');
  });
});

describe('outsideOperands', () => {
  const top = [
    dir('.Spotlight-V100'),
    dir('.PreviousSystemInformation'),
    dir('Applications'),
    dir('Library'),
    dir('System'),
    dir('Users'),
    dir('Volumes'),
    dir('home'),
    dir('Network'),
    dir('opt'),
    dir('private'),
    dir('usr'),
    dir('sw'),
  ];
  const users = [dir('.localized', { directory: false }), dir('.hidden'), dir('Shared'), dir('ana'), dir('ana2'), dir('bob')];

  it('measures each top folder and every account but the person’s own', () => {
    expect(outsideOperands(top, users, 'ana', '/Users/ana')).toEqual([
      { path: `${D}/.PreviousSystemInformation`, segment: 'system-data' },
      { path: `${D}/Applications`, segment: 'apps' },
      { path: `${D}/Library`, segment: 'apps' },
      { path: `${D}/System`, segment: 'system-data' },
      { path: `${D}/Users/Shared`, segment: 'others' },
      { path: `${D}/Users/ana2`, segment: 'others' },
      { path: `${D}/Users/bob`, segment: 'others' },
      { path: `${D}/opt`, segment: 'dev' },
      { path: `${D}/private`, segment: 'system-data' },
      { path: `${D}/usr`, segment: 'dev' },
      { path: `${D}/sw`, segment: 'dev' },
    ]);
  });

  it('takes out only the exact account: ana, not ana2', () => {
    const paths = outsideOperands([dir('Users')], users, 'ana', '/Users/ana').map((operand) => operand.path);
    expect(paths).not.toContain(`${D}/Users/ana`);
    expect(paths).toContain(`${D}/Users/ana2`);
  });

  it('treats an account whose folder differs only in case as the person’s own', () => {
    const paths = outsideOperands([dir('Users')], [dir('meigston'), dir('Shared')], 'Meigston', '/Users/Meigston').map(
      (operand) => operand.path
    );
    expect(paths).toEqual([`${D}/Users/Shared`]);
  });

  it('never measures the data root, /Users whole, or anything that holds the home folder', () => {
    const all = outsideOperands(top, users, 'ana', '/Users/ana');
    for (const operand of all) {
      expect(operand.path).not.toBe(D);
      expect(operand.path).not.toBe(`${D}/Users`);
      expect(isUnder(`${D}/Users/ana`, operand.path)).toBe(false);
      expect(isUnder('/Users/ana', operand.path)).toBe(false);
    }
  });

  it('leaves out a top folder that holds a home outside /Users', () => {
    // Sem conta em /Users, a pasta pessoal em /opt/homes/ana tira /opt inteira da medida.
    const operands = outsideOperands([dir('opt'), dir('usr'), dir('Users')], [dir('bob')], null, '/opt/homes/ana');
    expect(operands).toEqual([
      { path: `${D}/usr`, segment: 'dev' },
      { path: `${D}/Users/bob`, segment: 'others' },
    ]);
  });

  it('leaves out an entry of /Users that holds the home folder deeper down', () => {
    const operands = outsideOperands([dir('Users')], [dir('staff'), dir('bob')], null, '/Users/staff/ana');
    expect(operands).toEqual([{ path: `${D}/Users/bob`, segment: 'others' }]);
  });

  it('skips symbolic links, other devices and what is not a folder, at the top and in /Users', () => {
    const operands = outsideOperands(
      [
        dir('Applications', { symlink: true }),
        dir('Library', { sameDevice: false }),
        dir('opt', { directory: false }),
        dir('usr'),
        dir('Users'),
      ],
      [dir('bob', { symlink: true }), dir('carol', { sameDevice: false }), dir('dave', { directory: false }), dir('eve')],
      'ana',
      '/Users/ana'
    );
    expect(operands).toEqual([
      { path: `${D}/usr`, segment: 'dev' },
      { path: `${D}/Users/eve`, segment: 'others' },
    ]);
  });

  it('ignores every account when /Users itself is a link or another disk', () => {
    expect(outsideOperands([dir('Users', { symlink: true })], [dir('bob')], 'ana', '/Users/ana')).toEqual([]);
    expect(outsideOperands([dir('Users', { sameDevice: false })], [dir('bob')], 'ana', '/Users/ana')).toEqual([]);
  });

  it('follows another data root', () => {
    expect(outsideOperands([dir('opt'), dir('Users')], [dir('ana'), dir('bob')], 'ana', '/Users/ana', '/Vol')).toEqual([
      { path: '/Vol/opt', segment: 'dev' },
      { path: '/Vol/Users/bob', segment: 'others' },
    ]);
  });
});

describe('userVarFolder', () => {
  it('finds the account folder in /var/folders, with or without the trailing slash', () => {
    expect(userVarFolder('/var/folders/9z/abc123/T')).toBe(`${D}/private/var/folders/9z/abc123`);
    expect(userVarFolder('/var/folders/9z/abc123/T/')).toBe(`${D}/private/var/folders/9z/abc123`);
  });

  it('accepts the /private/var/folders spelling', () => {
    expect(userVarFolder('/private/var/folders/9z/abc123/T/')).toBe(`${D}/private/var/folders/9z/abc123`);
  });

  it('follows another data root', () => {
    expect(userVarFolder('/var/folders/9z/abc123/T', '/Vol')).toBe('/Vol/private/var/folders/9z/abc123');
  });

  it('refuses what is not the account temporary folder', () => {
    expect(userVarFolder('/tmp')).toBeNull();
    expect(userVarFolder('/private/tmp')).toBeNull();
    expect(userVarFolder('/var/folders/9z/T')).toBeNull();
    expect(userVarFolder('/var/folders/9z/abc123/C')).toBeNull();
    expect(userVarFolder('/var/folders/9z/abc123/T/sub')).toBeNull();
    expect(userVarFolder('')).toBeNull();
  });
});

describe('outsideCarves', () => {
  const VAR = `${D}/private/var/folders/9z/abc123`;
  const assets = duSizes(
    [
      ['System/Library/AssetsV2', 1],
      ['System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime', 1],
      ['System/Library/AssetsV2/com_apple_MobileAsset_xrOSSimulatorRuntime', 1],
      ['System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime/nested_SimulatorRuntime', 1],
      ['System/Library/AssetsV2/com_apple_MobileAsset_Font8', 1],
      ['System/Library/AssetsV2/SimulatorRuntimeBackup', 1],
      ['System/Library/Assets/com_apple_MobileAsset_watchOSSimulatorRuntime', 1],
      ['Library/Developer/CoreSimulator/Images/iOS_SimulatorRuntime', 1],
    ],
    D
  );

  it('carves the fixed folders and the account temporary folder', () => {
    expect(outsideCarves(D, VAR, new Map())).toEqual([
      { path: `${D}/Library/Developer`, segment: 'dev' },
      { path: `${D}/Library/Caches`, segment: 'caches' },
      { path: `${D}/private/tmp`, segment: 'caches' },
      { path: `${D}/private/var/tmp`, segment: 'caches' },
      { path: `${D}/private/var/vm`, segment: 'vm' },
      { path: VAR, segment: 'caches' },
    ]);
    expect(outsideCarves(D, null, new Map()).map((carve) => carve.path)).not.toContain(VAR);
  });

  it('finds only the simulator runtimes right inside System/Library/AssetsV2', () => {
    const runtimes = outsideCarves(D, VAR, assets).filter((carve) => carve.path.includes('SimulatorRuntime'));
    expect(runtimes).toEqual([
      { path: `${D}/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime`, segment: 'dev' },
      { path: `${D}/System/Library/AssetsV2/com_apple_MobileAsset_xrOSSimulatorRuntime`, segment: 'dev' },
    ]);
  });

  it('never carves a folder inside another carve', () => {
    const carves = outsideCarves(D, VAR, assets);
    for (const a of carves) {
      for (const b of carves) if (a !== b) expect(isUnder(a.path, b.path)).toBe(false);
    }
  });
});

describe('visiblePath', () => {
  it('shows a firmlinked folder at the root of the disk', () => {
    expect(visiblePath(`${D}/Applications/Xcode.app`, DEFAULT_FIRMLINKS)).toBe('/Applications/Xcode.app');
    expect(visiblePath(`${D}/Library`, DEFAULT_FIRMLINKS)).toBe('/Library');
    expect(visiblePath(`${D}/private/var/vm`, DEFAULT_FIRMLINKS)).toBe('/private/var/vm');
    expect(visiblePath(`${D}/usr/local/bin`, DEFAULT_FIRMLINKS)).toBe('/usr/local/bin');
    expect(visiblePath(`${D}/Users/bob`, DEFAULT_FIRMLINKS)).toBe('/Users/bob');
    expect(visiblePath(`${D}/System/Library/AssetsV2/x`, DEFAULT_FIRMLINKS)).toBe('/System/Library/AssetsV2/x');
  });

  it('shows a folder that only holds firmlinks by their common ancestor', () => {
    expect(visiblePath(`${D}/usr`, DEFAULT_FIRMLINKS)).toBe('/usr');
    expect(visiblePath(`${D}/System`, DEFAULT_FIRMLINKS)).toBe('/System/Library');
    expect(visiblePath(`${D}/System/Library`, DEFAULT_FIRMLINKS)).toBe('/System/Library');
  });

  it('keeps the data volume path for what is not firmlinked', () => {
    expect(visiblePath(`${D}/sw`, DEFAULT_FIRMLINKS)).toBe(`${D}/sw`);
    expect(visiblePath(`${D}/.PreviousSystemInformation`, DEFAULT_FIRMLINKS)).toBe(`${D}/.PreviousSystemInformation`);
    // Prefixo de nome não é pasta: Applications2 não é Applications.
    expect(visiblePath(`${D}/Applications2`, DEFAULT_FIRMLINKS)).toBe(`${D}/Applications2`);
  });

  it('leaves a path outside the data volume as it is', () => {
    expect(visiblePath('/Applications/Xcode.app', DEFAULT_FIRMLINKS)).toBe('/Applications/Xcode.app');
    expect(visiblePath(D, DEFAULT_FIRMLINKS)).toBe(D);
    expect(visiblePath('/System/Volumes/Database/x', DEFAULT_FIRMLINKS)).toBe('/System/Volumes/Database/x');
  });

  it('works with the firmlinks file as macOS ships it', () => {
    const shipped = parseFirmlinks(
      [
        '/Applications\tApplications',
        '/Library\tLibrary',
        '/System/Library/Caches\tSystem/Library/Caches',
        '/System/Library/AssetsV2\tSystem/Library/AssetsV2',
        '/System/Library/CoreServices/CoreTypes.bundle/Contents/Library\tSystem/Library/CoreServices/CoreTypes.bundle/Contents/Library',
        '/Users\tUsers',
        '/private\tprivate',
        '/usr/local\tusr/local',
        '/usr/libexec/cups\tusr/libexec/cups',
        '/usr/share/snmp\tusr/share/snmp',
        '',
      ].join('\n')
    );
    expect(visiblePath(`${D}/usr`, shipped)).toBe('/usr');
    expect(visiblePath(`${D}/System`, shipped)).toBe('/System/Library');
    expect(visiblePath(`${D}/usr/libexec/cups/x`, shipped)).toBe('/usr/libexec/cups/x');
  });

  it('follows another data root', () => {
    expect(visiblePath('/Vol/Applications/Xcode.app', DEFAULT_FIRMLINKS, '/Vol')).toBe('/Applications/Xcode.app');
    expect(visiblePath(`${D}/Applications/Xcode.app`, DEFAULT_FIRMLINKS, '/Vol')).toBe(`${D}/Applications/Xcode.app`);
  });
});

// Um volume de dados inteiro, em du -k -x -d 4 (KiB), com a conta ana fora da medida.
const VAR_FOLDER = `${D}/private/var/folders/9z/abc123`;
const OUTSIDE_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['Applications', 41943040],
  ['Applications/Xcode.app', 36700160],
  ['Applications/Xcode.app/Contents', 36700156],
  ['Applications/Xcode.app/Contents/Developer', 31457280],
  ['Applications/Xcode.app/Contents/SharedFrameworks', 3145728],
  ['Applications/Docker.app', 2621440],
  ['Applications/Slack.app', 51200],
  ['Library', 62914560],
  ['Library/Developer', 20971520],
  ['Library/Developer/CoreSimulator', 20971000],
  ['Library/Caches', 2097152],
  ['Library/Caches/com.apple.amsengagementd', 1572864],
  ['Library/Application Support', 10485760],
  ['Library/Frameworks', 1048576],
  ['opt', 4194304],
  ['opt/homebrew', 4194300],
  ['usr', 1048576],
  ['usr/local', 1048576],
  ['private', 15728640],
  ['private/tmp', 1048576],
  ['private/tmp/build', 51200],
  ['private/etc', 1048576],
  ['private/var', 13631488],
  ['private/var/tmp', 524288],
  ['private/var/folders', 6291456],
  ['private/var/folders/9z', 6291456],
  ['private/var/folders/9z/abc123', 5242880],
  ['private/var/db', 4194304],
  ['private/var/log', 2621440],
  ['System', 31457280],
  ['System/Library', 31457280],
  ['System/Library/AssetsV2', 19924992],
  ['System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime', 18874368],
  ['System/Library/AssetsV2/com_apple_MobileAsset_Font8', 1048576],
  ['System/Library/Caches', 1048576],
  ['System/Library/PreinstalledAssets', 9437184],
  ['.PreviousSystemInformation', 1024],
  ['Users/bob', 8388608],
  ['Users/bob/Documents', 6291456],
  ['Users/bob/Library', 2048000],
  ['Users/bob/Desktop', 49152],
  ['Users/Shared', 102400],
  ['Users/Shared/Previously Relocated Items', 10240],
];
const OUTSIDE_TOP = [
  dir('.Spotlight-V100'),
  dir('.PreviousSystemInformation'),
  dir('Applications'),
  dir('Library'),
  dir('System'),
  dir('Users'),
  dir('Volumes'),
  dir('opt'),
  dir('private'),
  dir('usr'),
];
const OUTSIDE_USERS = [dir('.localized', { directory: false }), dir('Shared'), dir('ana'), dir('bob')];
/** Σ das raízes, em KiB. */
const OUTSIDE_TOTAL_KIB = 41943040 + 62914560 + 4194304 + 1048576 + 15728640 + 31457280 + 1024 + 8388608 + 102400;

function outsideScenario(denied: readonly string[] = [], at = 1_000) {
  const sizes = duSizes(OUTSIDE_ROWS, D);
  const operands = outsideOperands(OUTSIDE_TOP, OUTSIDE_USERS, 'ana', '/Users/ana');
  const carves = outsideCarves(D, userVarFolder('/var/folders/9z/abc123/T/'), sizes);
  return { sizes, operands, carves, measure: classifyOutside(sizes, operands, carves, denied, at) };
}

describe('classifyOutside', () => {
  it('splits what du measured so the segments add up to the roots, byte for byte', () => {
    const { sizes, operands, measure } = outsideScenario();
    const roots = operands.reduce((sum, operand) => sum + (sizes.get(operand.path) ?? 0), 0);
    const segments = [...measure.segments.values()].reduce((sum, entry) => sum + entry.bytes, 0);

    expect(roots).toBe(OUTSIDE_TOTAL_KIB * KIB);
    expect(measure.total).toBe(roots);
    expect(segments).toBe(roots);
    for (const entry of measure.segments.values()) {
      expect(entry.bytes).toBe(entry.parts.reduce((sum, part) => sum + part.bytes, 0));
    }
    expect(measure.at).toBe(1_000);
  });

  it('gives each segment its folders, carved out of the roots', () => {
    const { measure } = outsideScenario();
    const bytes = Object.fromEntries([...measure.segments].map(([id, entry]) => [id, entry.bytes / KIB]));
    expect(bytes).toEqual({
      apps: 41943040 + (62914560 - 20971520 - 2097152),
      dev: 20971520 + 18874368 + 4194304 + 1048576,
      caches: 2097152 + 1048576 + 524288 + 5242880,
      'system-data': 15728640 - 1048576 - 524288 - 5242880 + (31457280 - 18874368) + 1024,
      others: 8388608 + 102400,
    });
    expect(measure.segments.get('caches')!.parts.map((part) => part.path)).toEqual([
      VAR_FOLDER,
      `${D}/Library/Caches`,
      `${D}/private/tmp`,
      `${D}/private/var/tmp`,
    ]);
  });

  it('counts an absent carve as zero', () => {
    const { measure } = outsideScenario();
    // private/var/vm não aparece no du: nada sai de private, e não nasce segmento vazio.
    expect(measure.segments.has('vm')).toBe(false);
    const privatePart = measure.segments.get('system-data')!.parts.find((part) => part.path === `${D}/private`);
    expect(privatePart?.bytes).toBe((15728640 - 1048576 - 524288 - 5242880) * KIB);
  });

  it('never yields a negative part, even when a carve says it is bigger than its root', () => {
    const sizes = new Map([
      [`${D}/Library`, 100 * KIB],
      [`${D}/Library/Caches`, 300 * KIB],
    ]);
    const operands = [{ path: `${D}/Library`, segment: 'apps' as const }];
    const measure = classifyOutside(sizes, operands, outsideCarves(D, null, sizes), [], 1);
    for (const entry of measure.segments.values()) {
      expect(entry.bytes).toBeGreaterThanOrEqual(0);
      for (const part of entry.parts) expect(part.bytes).toBeGreaterThanOrEqual(0);
      for (const top of entry.top) expect(top.bytes).toBeGreaterThanOrEqual(0);
    }
    expect(measure.segments.get('apps')?.bytes ?? 0).toBe(0);
  });

  it('nothing in the scenario is negative', () => {
    const { measure } = outsideScenario();
    for (const entry of measure.segments.values()) {
      expect(entry.bytes).toBeGreaterThan(0);
      for (const part of entry.parts) expect(part.bytes).toBeGreaterThan(0);
      for (const top of entry.top) expect(top.bytes).toBeGreaterThan(0);
    }
  });

  it('marks partial the segment of the most specific folder that was refused', () => {
    const { measure } = outsideScenario([
      `${D}/private/var/db/ConfigurationProfiles`,
      `${D}/Library/Caches/com.apple.aned`,
      `${D}/private/var/folders/9z/abc123/C/com.apple.x`,
      `${D}/Users/bob/Library/Mail`,
      `${D}/.Spotlight-V100/Store-V2`,
    ]);
    const partial = Object.fromEntries([...measure.segments].map(([id, entry]) => [id, entry.partial]));
    expect(partial).toEqual({ apps: false, dev: false, caches: true, 'system-data': true, others: true });
  });

  it('does not blame the root for a refusal inside a carve', () => {
    const { measure } = outsideScenario([`${D}/Library/Caches/com.apple.aned`]);
    expect(measure.segments.get('caches')!.partial).toBe(true);
    expect(measure.segments.get('apps')!.partial).toBe(false);
  });

  it('lists at most three subfolders of 100 MB or more, descending when one holds over 80% of its part', () => {
    const { measure } = outsideScenario();
    const top = (id: 'apps' | 'dev' | 'caches' | 'system-data' | 'others') =>
      measure.segments.get(id)!.top.map((entry) => [entry.path, entry.bytes / KIB]);

    // Xcode.app e Contents têm mais de 80% de /Applications: o que diz algo é o Developer lá dentro.
    expect(top('apps')).toEqual([
      [`${D}/Applications/Xcode.app/Contents/Developer`, 31457280],
      [`${D}/Library/Application Support`, 10485760],
      [`${D}/Applications/Xcode.app/Contents/SharedFrameworks`, 3145728],
    ]);
    // Sem subpasta mais funda medida, a que tem quase tudo fica.
    expect(top('dev')).toEqual([
      [`${D}/Library/Developer/CoreSimulator`, 20971000],
      [`${D}/opt/homebrew`, 4194300],
      [`${D}/usr/local`, 1048576],
    ]);
    // private/tmp/build tem 50 MB: fica de fora.
    expect(top('caches')).toEqual([[`${D}/Library/Caches/com.apple.amsengagementd`, 1572864]]);
    // Os recortes saem do tamanho das pastas de cima e nunca aparecem como subpasta.
    expect(top('system-data')).toEqual([
      [`${D}/System/Library/PreinstalledAssets`, 9437184],
      [`${D}/private/var/db`, 4194304],
      [`${D}/private/var/log`, 2621440],
    ]);
    // Documents tem 75% de bob: não se desce; Desktop (48 MB) fica de fora.
    expect(top('others')).toEqual([
      [`${D}/Users/bob/Documents`, 6291456],
      [`${D}/Users/bob/Library`, 2048000],
    ]);

    for (const entry of measure.segments.values()) {
      expect(entry.top.length).toBeLessThanOrEqual(3);
      for (const candidate of entry.top) expect(candidate.bytes).toBeGreaterThanOrEqual(100e6);
    }
  });

  it('never shows a carved folder as a subfolder of the segment it left', () => {
    const { measure, carves } = outsideScenario();
    const carved = new Set(carves.map((carve) => carve.path));
    for (const [id, entry] of measure.segments) {
      for (const candidate of entry.top) {
        const owner = carves.find((carve) => isUnder(candidate.path, carve.path));
        if (owner) expect(owner.segment).toBe(id);
        expect(carved.has(candidate.path)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Dentro da pasta pessoal
// ---------------------------------------------------------------------------

const HOME = '/Users/ana';
// A passada do DiskMap, em du -k -x -d 3 (KiB).
const HOME_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['Library', 59244544],
  ['Library/Developer', 31457280],
  ['Library/Developer/Xcode', 20971520],
  ['Library/Caches', 5242880],
  ['Library/Mail', 2097152],
  ['Library/Messages', 1048576],
  ['Library/Containers', 8388608],
  ['Library/Containers/com.docker.docker', 6291456],
  ['Library/Containers/com.apple.mail', 524288],
  ['Library/Containers/com.vendor.app', 1572864],
  ['Library/Group Containers', 1048576],
  ['Library/Group Containers/group.com.docker', 262144],
  ['Library/Mobile Documents', 3145728],
  ['Library/CloudStorage', 1048576],
  ['Library/Application Support', 4194304],
  ['Library/pnpm', 524288],
  ['.Trash', 2097152],
  ['.npm', 1048576],
  ['.cache', 3145728],
  ['.cache/huggingface', 2097152],
  ['.claude', 524288],
  ['Pictures', 20971520],
  ['Pictures/Photos Library.photoslibrary', 19922944],
  ['Pictures/Archive.PhotosLibrary', 524288],
  ['Documents', 10485760],
  ['Documents/Trip.photoslibrary', 262144],
  ['Desktop', 1048576],
];
const HOME_TOTAL_KIB = 59244544 + 2097152 + 1048576 + 3145728 + 524288 + 20971520 + 10485760 + 1048576 + 524288;

function homeSizes(rows: ReadonlyArray<readonly [string, number]> = HOME_ROWS, total = HOME_TOTAL_KIB) {
  return duSizes([['', total], ...rows], HOME);
}
const byId = (shares: HomeShareDTO[]) => Object.fromEntries(shares.map((share) => [share.id, share]));

describe('carveHome', () => {
  it('splits the home folder into shares that add up to it exactly', () => {
    const shares = carveHome(homeSizes(), HOME, []);
    const bytes = Object.fromEntries(shares.map((share) => [share.id, share.bytes / KIB]));

    expect(bytes).toEqual({
      dev: 31457280 + 6291456 + 262144 + 524288 + 1048576,
      ai: 2097152 + 524288,
      caches: 5242880,
      icloud: 3145728 + 1048576,
      photos: 19922944 + 524288,
      mail: 2097152 + 524288,
      messages: 1048576,
      trash: 2097152,
      'app-data': 59244544 - (31457280 + 5242880 + 2097152 + 1048576 + 6291456 + 524288 + 262144 + 3145728 + 1048576 + 524288),
      rest: HOME_TOTAL_KIB - 59244544 - (2097152 + 1048576 + 2097152 + 524288 + 19922944 + 524288),
    });
    expect(shares.reduce((sum, share) => sum + share.bytes, 0)).toBe(HOME_TOTAL_KIB * KIB);
  });

  it('sorts the shares and their paths from the largest down', () => {
    const shares = carveHome(homeSizes(), HOME, []);
    for (let index = 1; index < shares.length; index++) {
      expect(shares[index - 1].bytes).toBeGreaterThanOrEqual(shares[index].bytes);
    }
    expect(byId(shares).dev.paths.map((entry) => entry.path)).toEqual([
      `${HOME}/Library/Developer`,
      `${HOME}/Library/Containers/com.docker.docker`,
      `${HOME}/.npm`,
      `${HOME}/Library/pnpm`,
      `${HOME}/Library/Group Containers/group.com.docker`,
    ]);
    expect(byId(shares)['app-data'].paths).toEqual([{ path: `${HOME}/Library`, bytes: 7602176 * KIB }]);
    expect(byId(shares).rest.paths).toEqual([{ path: HOME, bytes: 13631488 * KIB }]);
  });

  it('takes only the photo libraries right inside Pictures', () => {
    const photos = byId(carveHome(homeSizes(), HOME, [])).photos;
    expect(photos.paths.map((entry) => entry.path)).toEqual([
      `${HOME}/Pictures/Photos Library.photoslibrary`,
      `${HOME}/Pictures/Archive.PhotosLibrary`,
    ]);
  });

  it('matches the rules regardless of case', () => {
    const sizes = new Map([
      [HOME, 1000 * KIB],
      [`${HOME}/library`, 600 * KIB],
      [`${HOME}/library/developer`, 400 * KIB],
      [`${HOME}/library/CACHES`, 100 * KIB],
      [`${HOME}/.TRASH`, 50 * KIB],
      [`${HOME}/pictures`, 200 * KIB],
      [`${HOME}/pictures/Fotos.PHOTOSLIBRARY`, 150 * KIB],
    ]);
    const shares = byId(carveHome(sizes, HOME, []));
    expect(shares.dev.paths).toEqual([{ path: `${HOME}/library/developer`, bytes: 400 * KIB }]);
    expect(shares.caches.bytes).toBe(100 * KIB);
    expect(shares.trash.bytes).toBe(50 * KIB);
    expect(shares.photos.bytes).toBe(150 * KIB);
    expect(shares['app-data'].bytes).toBe(100 * KIB);
    expect(shares.rest.bytes).toBe((1000 - 600 - 50 - 150) * KIB);
  });

  it('has no rule inside another, all within the three levels the pass measures', () => {
    const rules = HOME_RULES.map((rule) => rule.rel.toLowerCase());
    expect(new Set(rules).size).toBe(rules.length);
    for (const a of rules) {
      expect(a.split('/').length).toBeLessThanOrEqual(3);
      for (const b of rules) if (a !== b) expect(isUnder(b, a)).toBe(false);
    }
  });

  it('still adds up when there is no Library', () => {
    const sizes = new Map([
      [HOME, 1000 * KIB],
      [`${HOME}/.Trash`, 200 * KIB],
      [`${HOME}/Documents`, 300 * KIB],
    ]);
    const shares = carveHome(sizes, HOME, []);
    expect(shares.map((share) => [share.id, share.bytes / KIB])).toEqual([
      ['rest', 800],
      ['trash', 200],
    ]);
  });

  it('never yields negative app data or rest', () => {
    const sizes = new Map([
      [HOME, 1000 * KIB],
      [`${HOME}/Library`, 100 * KIB],
      [`${HOME}/Library/Caches`, 500 * KIB],
      [`${HOME}/.Trash`, 2000 * KIB],
    ]);
    const shares = carveHome(sizes, HOME, []);
    for (const share of shares) {
      expect(share.bytes).toBeGreaterThan(0);
      for (const entry of share.paths) expect(entry.bytes).toBeGreaterThan(0);
    }
    expect(shares.map((share) => share.id)).not.toContain('app-data');
    expect(shares.map((share) => share.id)).not.toContain('rest');
  });

  it('marks mail partial when a folder inside Library/Mail was refused', () => {
    const shares = byId(carveHome(homeSizes(), HOME, [`${HOME}/Library/Mail/V10/MailData`]));
    expect(shares.mail.partial).toBe(true);
    expect(shares['app-data'].partial).toBe(false);
    expect(shares.rest.partial).toBe(false);
  });

  it('marks mail partial when the Mail container was refused', () => {
    const shares = byId(carveHome(homeSizes(), HOME, [`${HOME}/Library/Containers/com.apple.mail/Data/Library`]));
    expect(shares.mail.partial).toBe(true);
    expect(shares['app-data'].partial).toBe(false);
  });

  it('marks partial the rest of Library or of the account for refusals without a rule', () => {
    const shares = byId(
      carveHome(homeSizes(), HOME, [`${HOME}/Library/Safari`, `${HOME}/Documents/Private`, '/Users/bob/Library/Mail'])
    );
    expect(shares['app-data'].partial).toBe(true);
    expect(shares.rest.partial).toBe(true);
    expect(Object.values(shares).filter((share) => share.partial).map((share) => share.id).sort()).toEqual(['app-data', 'rest']);
  });

  it('marks mail partial when macOS refused Library/Mail itself, as du reports it', () => {
    // Sem Acesso Total ao Disco, o du não imprime a pasta negada: só a linha de erro com ela.
    const rows = HOME_ROWS.filter(([relative]) => relative !== 'Library/Mail');
    const total = HOME_TOTAL_KIB - 2097152;
    const sizes = homeSizes(
      rows.map(([relative, kib]) => [relative, relative === 'Library' ? kib - 2097152 : kib] as const),
      total
    );
    const shares = byId(carveHome(sizes, HOME, [`${HOME}/Library/Mail`]));
    expect(shares.mail?.partial).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A conta
// ---------------------------------------------------------------------------

const CEILING = 994_662_584_320;
const FREE = 650_000_000_000;
const SYSTEM = 11_200_000_000;
const DATA = 320_000_000_000;
const PREBOOT = 7_000_000_000;
const RECOVERY = 1_200_000_000;
const UPDATE = 3_000_000;
const VM = 2_147_483_648;

function volumes(extra: ApfsVolume[] = []): ApfsVolume[] {
  return [
    { device: 'disk3s1', name: 'Macintosh HD', roles: ['System'], inUse: SYSTEM },
    { device: 'disk3s2', name: 'Preboot', roles: ['Preboot'], inUse: PREBOOT },
    { device: 'disk3s3', name: 'Recovery', roles: ['Recovery'], inUse: RECOVERY },
    { device: 'disk3s4', name: 'Update', roles: ['Update'], inUse: UPDATE },
    { device: 'disk3s5', name: 'Macintosh HD - Data', roles: ['Data'], inUse: DATA },
    { device: 'disk3s6', name: 'VM', roles: ['VM'], inUse: VM },
    ...extra,
  ];
}

function container(over: Partial<ApfsContainer> = {}): ApfsContainer {
  return { reference: 'disk3', ceiling: CEILING, free: FREE, volumes: volumes(), ...over };
}

const STRUCTURE = CEILING - FREE - (SYSTEM + PREBOOT + RECOVERY + UPDATE + DATA + VM);

function input(over: Partial<AssembleInput> = {}): AssembleInput {
  return {
    // `/` está no snapshot selado do volume do sistema.
    apfs: { container: container(), system: 'disk3s1s1', data: 'disk3s5' },
    statfs: { total: CEILING, free: FREE, dataUsed: DATA },
    volumeName: 'Macintosh HD',
    purgeable: null,
    snapshots: [],
    outside: null,
    home: null,
    homeOnData: true,
    homePath: HOME,
    phases: { outside: 'idle', home: 'idle' },
    dataAtMeasure: null,
    changedAt: null,
    otherAccounts: 0,
    fullDiskAccess: true,
    visible: (path) => visiblePath(path, DEFAULT_FIRMLINKS),
    ...over,
  };
}

function homeMeasure(bytes: number, at = 2_000, partial = false): NonNullable<AssembleInput['home']> {
  const shares: HomeShareDTO[] = [{ id: 'rest', bytes, paths: [{ path: HOME, bytes }], partial }];
  return { bytes, shares, partial, at };
}

const segmentSum = (dto: WholeDiskDTO) => dto.segments.reduce((sum, segment) => sum + segment.bytes, 0);
const ids = (dto: WholeDiskDTO) => dto.segments.map((segment) => segment.id);
const seg = (dto: WholeDiskDTO, id: WholeSegmentId) => dto.segments.find((segment) => segment.id === id);

function expectNothingNegative(dto: WholeDiskDTO) {
  for (const value of [dto.total, dto.free, dto.data, dto.systemVolumes, dto.otherVolumes, dto.overhead, dto.overcount]) {
    expect(value).toBeGreaterThanOrEqual(0);
  }
  for (const segment of dto.segments) {
    expect(segment.bytes).toBeGreaterThanOrEqual(0);
    expect(segment.bytes).toBe(segment.parts.reduce((sum, part) => sum + part.bytes, 0));
    for (const part of segment.parts) expect(part.bytes).toBeGreaterThan(0);
    for (const top of segment.top) expect(top.bytes).toBeGreaterThan(0);
  }
}

describe('assemble', () => {
  it('without any measure: the volumes, the data volume pending, and the sum closes on the total', () => {
    const dto = assemble(input());

    expect(dto.mode).toBe('apfs');
    expect(ids(dto)).toEqual(['macos', 'boot', 'vm', 'pending']);
    expect(seg(dto, 'macos')!.parts).toEqual([{ label: 'Macintosh HD', bytes: SYSTEM, source: 'apfs' }]);
    expect(seg(dto, 'boot')!.parts).toEqual([
      { label: 'Preboot', bytes: PREBOOT, source: 'apfs' },
      { label: '', bytes: STRUCTURE, source: 'apfs', special: 'structure' },
      { label: 'Recovery', bytes: RECOVERY, source: 'apfs' },
      { label: 'Update', bytes: UPDATE, source: 'apfs' },
    ]);
    expect(seg(dto, 'vm')!.bytes).toBe(VM);
    expect(seg(dto, 'pending')!.parts).toEqual([{ label: '', bytes: DATA, source: 'rest' }]);

    expect(segmentSum(dto) + dto.free).toBe(dto.total);
    expect(dto.total).toBe(CEILING);
    expect(dto.free).toBe(FREE);
    expect(dto.data).toBe(DATA);
    expect(dto.overhead).toBe(STRUCTURE);
    expect(dto.systemVolumes).toBe(SYSTEM + PREBOOT + RECOVERY + UPDATE + VM + STRUCTURE);
    expect(dto.otherVolumes).toBe(0);
    expect(dto.overcount).toBe(0);
    expect(dto.measuredAt).toBeNull();
    expect(dto.stale).toBe(false);
    expect(dto.home).toBeNull();
    expect(dto.homeElsewhere).toBe(false);
    expectNothingNegative(dto);
  });

  it('keeps the segments in the fixed order, each in its group', () => {
    const { measure } = outsideScenario();
    const dto = assemble(input({ outside: measure, home: homeMeasure(100e9) }));
    const order = ids(dto).map((id) => WHOLE_SEGMENTS.indexOf(id));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(Object.fromEntries(dto.segments.map((segment) => [segment.id, segment.group]))).toEqual({
      macos: 'system',
      boot: 'system',
      vm: 'system',
      'system-data': 'system',
      unknown: 'unknown',
      caches: 'yours',
      dev: 'yours',
      home: 'yours',
      apps: 'yours',
      others: 'yours',
    });
  });

  it('with only the outside measure: what is left of the data volume is pending', () => {
    const { measure } = outsideScenario();
    const dto = assemble(input({ outside: measure }));

    expect(ids(dto)).not.toContain('unknown');
    expect(ids(dto)).not.toContain('home');
    expect(seg(dto, 'pending')!.bytes).toBe(DATA - OUTSIDE_TOTAL_KIB * KIB);
    expect(segmentSum(dto) + dto.free).toBe(dto.total);
    expect(dto.measuredAt).toBeNull();
    expectNothingNegative(dto);
  });

  it('with both measures: what neither reached is unknown, and the sum closes', () => {
    const { measure } = outsideScenario([], 1_000);
    const home = homeMeasure(120e9, 2_000);
    const dto = assemble(input({ outside: measure, home }));

    expect(ids(dto)).not.toContain('pending');
    expect(seg(dto, 'unknown')!.bytes).toBe(DATA - OUTSIDE_TOTAL_KIB * KIB - 120e9);
    expect(seg(dto, 'home')!.parts).toEqual([{ label: '~', path: HOME, bytes: 120e9, source: 'du' }]);
    expect(dto.home).toBe(home.shares);
    expect(segmentSum(dto) + dto.free).toBe(dto.total);
    expect(dto.overcount).toBe(0);
    expect(dto.measuredAt).toBe(1_000);
    expectNothingNegative(dto);
  });

  it('shows the outside parts and subfolders by the path the Finder shows', () => {
    const { measure } = outsideScenario();
    const dto = assemble(input({ outside: measure, home: homeMeasure(100e9) }));

    expect(seg(dto, 'apps')!.parts.map((part) => part.label)).toEqual(['/Applications', '/Library']);
    expect(seg(dto, 'dev')!.parts.map((part) => part.path)).toEqual([
      '/Library/Developer',
      '/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime',
      '/opt',
      '/usr',
    ]);
    expect(seg(dto, 'system-data')!.parts.map((part) => part.path)).toEqual([
      '/System/Library',
      '/private',
      `${D}/.PreviousSystemInformation`,
    ]);
    expect(seg(dto, 'apps')!.top[0]).toEqual({
      label: '/Applications/Xcode.app/Contents/Developer',
      path: '/Applications/Xcode.app/Contents/Developer',
      bytes: 31457280 * KIB,
    });
    for (const segment of dto.segments) expect(segment.top.length).toBeLessThanOrEqual(3);
  });

  it('counted more than the data volume holds: no unknown or pending, the excess as overcount, nothing negative', () => {
    const { measure } = outsideScenario();
    const dto = assemble(input({ outside: measure, home: homeMeasure(200e9) }));
    const measured = OUTSIDE_TOTAL_KIB * KIB + 200e9;

    expect(ids(dto)).not.toContain('unknown');
    expect(ids(dto)).not.toContain('pending');
    expect(dto.overcount).toBe(measured - DATA);
    expect(segmentSum(dto) + dto.free).toBe(dto.total + dto.overcount);
    expectNothingNegative(dto);
  });

  it('turns a negative APFS structure into zero', () => {
    const inUse = SYSTEM + PREBOOT + RECOVERY + UPDATE + DATA + VM;
    const apfs = { container: container({ free: CEILING - inUse + 5_000_000 }), system: 'disk3s1s1', data: 'disk3s5' };
    const dto = assemble(input({ apfs }));

    expect(dto.overhead).toBe(0);
    expect(seg(dto, 'boot')!.parts.some((part) => part.special === 'structure')).toBe(false);
    expect(seg(dto, 'boot')!.bytes).toBe(PREBOOT + RECOVERY + UPDATE);
    expectNothingNegative(dto);
  });

  it('sends extra volumes to other volumes, and xART and Hardware to startup', () => {
    const extra: ApfsVolume[] = [
      { device: 'disk3s7', name: 'Macintosh HD 2', roles: ['System'], inUse: 10_000_000_000 },
      { device: 'disk3s8', name: 'Macintosh HD 2 - Data', roles: ['Data'], inUse: 40_000_000_000 },
      { device: 'disk3s9', name: 'Scratch', roles: [], inUse: 5_000_000_000 },
      { device: 'disk3s10', name: 'Future', roles: ['Backup'], inUse: 1_000_000_000 },
      { device: 'disk3s11', name: 'xART', roles: ['xART'], inUse: 6_000_000 },
      { device: 'disk3s12', name: 'Hardware', roles: ['Hardware'], inUse: 5_000_000 },
    ];
    const free = 594_000_000_000;
    const all = volumes(extra);
    const structure = CEILING - free - all.reduce((sum, volume) => sum + volume.inUse, 0);
    const dto = assemble(input({ apfs: { container: container({ free, volumes: all }), system: 'disk3s1s1', data: 'disk3s5' } }));

    expect(seg(dto, 'other-volumes')!.parts.map((part) => [part.label, part.bytes])).toEqual([
      ['Macintosh HD 2 - Data', 40_000_000_000],
      ['Macintosh HD 2', 10_000_000_000],
      ['Scratch', 5_000_000_000],
      ['Future', 1_000_000_000],
    ]);
    expect(seg(dto, 'other-volumes')!.group).toBe('yours');
    expect(dto.otherVolumes).toBe(56_000_000_000);
    expect(seg(dto, 'boot')!.parts.map((part) => part.label)).toEqual(['Preboot', '', 'Recovery', 'xART', 'Hardware', 'Update']);
    expect(seg(dto, 'macos')!.bytes).toBe(SYSTEM);
    expect(dto.overhead).toBe(structure);
    expect(dto.systemVolumes).toBe(CEILING - free - DATA - 56_000_000_000);
    expect(segmentSum(dto) + dto.free).toBe(dto.total);
    expectNothingNegative(dto);
  });

  it('falls back to statfs in basic mode', () => {
    const dto = assemble(
      input({ apfs: null, statfs: { total: 500_000_000_000, free: 200_000_000_000, dataUsed: 250_000_000_000 } })
    );
    expect(dto.mode).toBe('basic');
    expect(dto.total).toBe(500_000_000_000);
    expect(dto.free).toBe(200_000_000_000);
    expect(dto.data).toBe(250_000_000_000);
    expect(dto.systemVolumes).toBe(50_000_000_000);
    expect(dto.overhead).toBe(0);
    expect(dto.otherVolumes).toBe(0);
    expect(ids(dto)).toEqual(['macos', 'pending']);
    expect(seg(dto, 'macos')!.parts).toEqual([{ label: 'Macintosh HD', bytes: 50_000_000_000, source: 'statfs' }]);
    expect(segmentSum(dto) + dto.free).toBe(dto.total);
    expectNothingNegative(dto);
  });

  it('in basic mode, without the data volume, takes all that is used as data', () => {
    const dto = assemble(input({ apfs: null, statfs: { total: 500e9, free: 200e9, dataUsed: null } }));
    expect(dto.data).toBe(300e9);
    expect(dto.systemVolumes).toBe(0);
    expect(ids(dto)).toEqual(['pending']);
    expect(segmentSum(dto) + dto.free).toBe(dto.total);

    const capped = assemble(input({ apfs: null, statfs: { total: 500e9, free: 200e9, dataUsed: 400e9 } }));
    expect(capped.data).toBe(300e9);
    expect(capped.systemVolumes).toBe(0);
  });

  it('goes basic when the APFS volumes do not match the devices', () => {
    const statfs = { total: 500e9, free: 200e9, dataUsed: 250e9 };
    const unknown = assemble(input({ statfs, apfs: { container: container(), system: 'disk9s1s1', data: 'disk3s5' } }));
    expect(unknown.mode).toBe('basic');
    const same = assemble(input({ statfs, apfs: { container: container(), system: 'disk3s5', data: 'disk3s5' } }));
    expect(same.mode).toBe('basic');
    expect(same.total).toBe(500e9);
  });

  it('leaves the home folder out when it lives on another disk', () => {
    const { measure } = outsideScenario([], 1_000);
    const dto = assemble(input({ outside: measure, home: homeMeasure(120e9), homeOnData: false }));

    expect(ids(dto)).not.toContain('home');
    expect(dto.home).toBeNull();
    expect(dto.homeElsewhere).toBe(true);
    expect(seg(dto, 'unknown')!.bytes).toBe(DATA - OUTSIDE_TOTAL_KIB * KIB);
    expect(dto.measuredAt).toBe(1_000);
    expect(segmentSum(dto) + dto.free).toBe(dto.total);
  });

  it('never adds the purgeable space to the segments', () => {
    const { measure } = outsideScenario();
    const none = assemble(input({ outside: measure, home: homeMeasure(120e9), purgeable: 0 }));
    const some = assemble(input({ outside: measure, home: homeMeasure(120e9), purgeable: 800_000_000 }));
    expect(some.segments).toEqual(none.segments);
    expect(some.free).toBe(none.free);
    expect(none.purgeable).toBe(0);
    expect(some.purgeable).toBe(800_000_000);
  });

  it('marks the measure stale when the data volume moved or something was cleaned after it', () => {
    const { measure } = outsideScenario([], 1_000);
    const both = { outside: measure, home: homeMeasure(120e9, 2_000) };

    const moved = assemble(input({ ...both, dataAtMeasure: DATA - 2e9 }));
    expect(moved.drift).toBe(2e9);
    expect(moved.stale).toBe(true);

    const still = assemble(input({ ...both, dataAtMeasure: DATA - 5e8 }));
    expect(still.drift).toBe(5e8);
    expect(still.stale).toBe(false);

    expect(assemble(input({ ...both, dataAtMeasure: DATA, changedAt: 1_500 })).stale).toBe(true);
    expect(assemble(input({ ...both, dataAtMeasure: DATA, changedAt: 500 })).stale).toBe(false);

    // Sem as duas medidas não há o que ficar para trás.
    const half = assemble(input({ outside: measure, dataAtMeasure: DATA - 5e9, changedAt: 9_999 }));
    expect(half.drift).toBe(0);
    expect(half.stale).toBe(false);
  });

  it('keeps a home folder that is only partial', () => {
    const { measure } = outsideScenario();
    const dto = assemble(input({ outside: measure, home: homeMeasure(120e9, 2_000, true) }));
    expect(seg(dto, 'home')!.partial).toBe(true);
  });

  it('keeps the partial mark of an outside segment that only had a refusal', () => {
    // /private/var/vm negada: o du não imprime a pasta, e o segmento de fora fica só com a marca.
    const { measure } = outsideScenario([`${D}/private/var/vm`]);
    expect(measure.segments.get('vm')).toMatchObject({ bytes: 0, partial: true });
    const dto = assemble(input({ outside: measure, home: homeMeasure(120e9) }));
    expect(seg(dto, 'vm')!.partial).toBe(true);
  });
});

describe('isStale', () => {
  it('is never stale before both measures finished', () => {
    expect(isStale(50e9, 9_999, null)).toBe(false);
  });

  it('is stale beyond 1 GB of change, either way', () => {
    expect(isStale(1e9, null, 1_000)).toBe(false);
    expect(isStale(1e9 + 1, null, 1_000)).toBe(true);
    expect(isStale(-1.5e9, null, 1_000)).toBe(true);
    expect(isStale(0, null, 1_000)).toBe(false);
  });

  it('is stale when something changed the disk after the measure', () => {
    expect(isStale(0, 1_001, 1_000)).toBe(true);
    expect(isStale(0, 1_000, 1_000)).toBe(false);
    expect(isStale(0, 999, 1_000)).toBe(false);
  });
});

describe('wholeOptions', () => {
  it('turns an option on only for a real true', () => {
    expect(wholeOptions({ measure: true })).toEqual({ measure: true, refresh: false });
    expect(wholeOptions({ measure: true, refresh: true })).toEqual({ measure: true, refresh: true });
    expect(wholeOptions({ refresh: true })).toEqual({ measure: false, refresh: true });
  });

  it('measures nothing for anything else', () => {
    const off = { measure: false, refresh: false };
    expect(wholeOptions(undefined)).toEqual(off);
    expect(wholeOptions(null)).toEqual(off);
    expect(wholeOptions(true)).toEqual(off);
    expect(wholeOptions('measure')).toEqual(off);
    expect(wholeOptions([true, true])).toEqual(off);
    expect(wholeOptions({ measure: 'true', refresh: 1 })).toEqual(off);
    expect(wholeOptions({ measure: {}, refresh: [true] })).toEqual(off);
  });
});
