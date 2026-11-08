import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WHOLE_SEGMENTS, type WholeDiskDTO, type WholeDiskProgress, type WholeSegmentId } from '../shared/api';
import { DiskMap } from './disk';
import { WholeDisk, type Runner } from './whole-disk';

/**
 * A classe WholeDisk de ponta a ponta, num volume de dados de mentira: uma pasta
 * temporária com a cara de /System/Volumes/Data, o DiskMap e o du de verdade, e
 * um diskutil/plutil/osascript/tmutil falso que responde como um Mac com APFS.
 * Nada aqui olha a pasta pessoal de quem roda os testes.
 */

// O contêiner APFS do Mac de mentira, em bytes.
const TOTAL = 500_000_000_000;
const FREE = 180_000_000_000;
const SYSTEM = 12_000_000_000;
const PREBOOT = 7_000_000_000;
const RECOVERY = 1_200_000_000;
const VM = 2_000_000_000;
const DATA = 290_000_000_000;
const PURGEABLE = 9_500_000_000;
const GROUP = '5A1E2B3C-0000-4000-8000-000000000001';

/** A pasta temporária da conta, do jeito que o os.tmpdir() a dá: vira dataRoot/private/var/folders/ab/cdef. */
const TMP = '/var/folders/ab/cdef/T';
const SIM = 'System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime';
const VAR_FOLDER = 'private/var/folders/ab/cdef';

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** O que o próprio du dá para um caminho; zero para o que não existe. */
function duBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const out = execFileSync('/usr/bin/du', ['-sk', path], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return Number(out.split('\t')[0]) * 1024;
}

/** Um du que anota cada chamada (os argumentos, um por linha) e entrega ao du de verdade. */
async function loggingDu(path: string, log: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    ['#!/bin/sh', `{ printf 'CALL\\n'; for arg in "$@"; do printf '%s\\n' "$arg"; done; } >> '${log}'`, 'exec /usr/bin/du "$@"', ''].join(
      '\n'
    )
  );
  await chmod(path, 0o755);
  return path;
}

/** As chamadas que um du anotou: cada uma é a lista de argumentos. */
async function calls(log: string): Promise<string[][]> {
  const content = await readFile(log, 'utf8').catch(() => '');
  return content
    .split('CALL\n')
    .slice(1)
    .map((chunk) => chunk.split('\n').filter((line) => line !== ''));
}

interface FakeState {
  dataRoot: string;
  /** CapacityInUse do volume de dados; o teste pode mudá-lo entre leituras. */
  data: number;
  failDiskutil: boolean;
}

/** O que o diskutil "imprimiria", já convertido pelo plutil, para os argumentos dados. */
function plistFor(args: string[], state: FakeState): unknown {
  const key = args.join(' ');
  if (key === 'info -plist /') {
    return {
      DeviceIdentifier: 'disk3s1s1',
      APFSContainerReference: 'disk3',
      VolumeName: 'Macintosh HD',
      FilesystemType: 'apfs',
      APFSVolumeGroupID: GROUP,
    };
  }
  if (key === `info -plist ${state.dataRoot}`) {
    return {
      DeviceIdentifier: 'disk3s5',
      APFSContainerReference: 'disk3',
      VolumeName: 'Macintosh HD - Data',
      FilesystemType: 'apfs',
      APFSVolumeGroupID: GROUP,
    };
  }
  if (key === 'apfs list -plist disk3') {
    return {
      Containers: [
        {
          ContainerReference: 'disk1',
          CapacityCeiling: 524_288_000,
          CapacityFree: 500_000_000,
          Volumes: [{ DeviceIdentifier: 'disk1s1', Name: 'iSCPreboot', Roles: ['Preboot'], CapacityInUse: 8_000_000 }],
        },
        {
          ContainerReference: 'disk3',
          CapacityCeiling: TOTAL,
          CapacityFree: FREE,
          Volumes: [
            { DeviceIdentifier: 'disk3s1', Name: 'Macintosh HD', Roles: ['System'], CapacityInUse: SYSTEM },
            { DeviceIdentifier: 'disk3s2', Name: 'Preboot', Roles: ['Preboot'], CapacityInUse: PREBOOT },
            { DeviceIdentifier: 'disk3s3', Name: 'Recovery', Roles: ['Recovery'], CapacityInUse: RECOVERY },
            { DeviceIdentifier: 'disk3s5', Name: 'Macintosh HD - Data', Roles: ['Data'], CapacityInUse: state.data },
            { DeviceIdentifier: 'disk3s6', Name: 'VM', Roles: ['VM'], CapacityInUse: VM },
          ],
        },
      ],
    };
  }
  throw new Error(`diskutil: unexpected ${key}`);
}

/**
 * diskutil devolve um plist com os próprios argumentos num comentário; o plutil
 * lê esse comentário e devolve o JSON que corresponde ao XML recebido.
 */
function fakeRunner(state: FakeState) {
  const log: Array<{ file: string; args: string[] }> = [];
  const run: Runner = async (file, args, input) => {
    log.push({ file, args });
    switch (file) {
      case '/usr/sbin/diskutil':
        if (state.failDiskutil) throw new Error('diskutil: Unable to run');
        return [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<plist version="1.0"><dict/></plist>',
          `<!-- args ${JSON.stringify(args)} -->`,
          '',
        ].join('\n');
      case '/usr/bin/plutil': {
        if (args.join(' ') !== '-convert json -o - -') throw new Error(`plutil: unexpected ${args.join(' ')}`);
        const match = /<!-- args (.*) -->/.exec(input ?? '');
        if (!match) throw new Error('plutil: not a plist');
        return JSON.stringify(plistFor(JSON.parse(match[1]) as string[], state));
      }
      case '/usr/bin/osascript':
        return JSON.stringify({ available: FREE, important: FREE + PURGEABLE });
      case '/usr/bin/tmutil':
        return 'Snapshots for disk /:\ncom.apple.TimeMachine.2026-11-07-101010.local\n';
      default:
        throw new Error(`unexpected command ${file}`);
    }
  };
  return { run, log };
}

const bytesOf = (dto: WholeDiskDTO) => Object.fromEntries(dto.segments.map((segment) => [segment.id, segment.bytes]));
const segmentOf = (dto: WholeDiskDTO, id: WholeSegmentId) => dto.segments.find((segment) => segment.id === id);
const closes = (dto: WholeDiskDTO) => {
  expect(dto.overcount).toBe(0);
  expect(sum(dto.segments.map((segment) => segment.bytes)) + dto.free).toBe(dto.total);
};

describe('WholeDisk (integração com pastas temporárias)', () => {
  let root: string;
  let dataRoot: string;
  let home: string;
  let outsideLog: string;
  let homeLog: string;
  let outsideDu: string;
  let homeDu: string;
  let state: FakeState;
  let skew: number;
  /** Bytes escritos por caminho relativo ao dataRoot. */
  const written = new Map<string, number>();

  async function file(relative: string, bytes: number) {
    const path = join(dataRoot, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes, 1));
    written.set(relative, bytes);
  }
  const writtenUnder = (prefix: string) =>
    sum([...written].filter(([relative]) => relative.startsWith(prefix + '/')).map(([, bytes]) => bytes));
  const d = (relative: string) => duBytes(join(dataRoot, relative));

  function make(deps: { du?: string; homeDu?: string; firmlinks?: string } = {}) {
    const fake = fakeRunner(state);
    const disk = new DiskMap(home, deps.homeDu ?? homeDu);
    const whole = new WholeDisk(disk, {
      run: fake.run,
      du: deps.du ?? outsideDu,
      dataRoot,
      tmpdir: TMP,
      firmlinks: deps.firmlinks ?? join(root, 'no-firmlinks'),
      now: () => Date.now() + skew,
    });
    return { whole, disk, fake };
  }

  beforeEach(async () => {
    // O realpath tira os links do caminho, mas devolve /private/var/...: o WholeDisk junta
    // dataRoot + home pensando numa pasta pessoal como /Users/x, e uma que começa em /private
    // cairia dentro de dataRoot/private, que então sairia do du. O apelido /var (ou /tmp) é o
    // mesmo lugar sem esse prefixo.
    root = (await realpath(await mkdtemp(join(tmpdir(), 'macleanfy-whole-')))).replace(/^\/private(?=\/(?:var|tmp)\/)/, '');
    dataRoot = join(root, 'Data');
    home = join(dataRoot, 'Users', 'ana');
    outsideLog = join(root, 'du-outside.log');
    homeLog = join(root, 'du-home.log');
    outsideDu = await loggingDu(join(root, 'bin', 'du-outside'), outsideLog);
    homeDu = await loggingDu(join(root, 'bin', 'du-home'), homeLog);
    state = { dataRoot, data: DATA, failDiskutil: false };
    skew = 0;
    written.clear();

    await file('Applications/Tool.app/Contents/MacOS/tool', 300_000);
    await file('Library/Application Support/vendor/blob', 120_000);
    await file('Library/Developer/Xcode/DerivedData/build.o', 400_000);
    await file('Library/Caches/com.vendor/cache.bin', 250_000);
    await file('private/tmp/scratch.bin', 90_000);
    await file('private/var/vm/sleepimage', 500_000);
    await file('private/var/db/receipts.db', 70_000);
    await file(`${VAR_FOLDER}/T/item`, 60_000);
    await file(`${SIM}/runtime.dmg`, 350_000);
    await file('System/Library/AssetsV2/com_apple_MobileAsset_Font/font.bin', 40_000);
    await file('Users/ana/Documents/report.pdf', 1_000_000);
    await file('Users/ana/Library/Caches/app/blob', 200_000);
    await file('Users/ana/Library/Developer/sim/data', 150_000);
    await file('Users/ana/.Trash/old.zip', 30_000);
    await file('Users/Shared/shared.bin', 80_000);
    // Pontos de montagem e autofs: se o du de fora entrasse aqui, a conta não fecharia.
    await file('Volumes/x/huge.bin', 2_000_000);
    await file('home/stuff.bin', 1_500_000);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('sem measure, lê só os volumes: nenhum du roda e o volume de dados inteiro fica pendente', async () => {
    const { whole, disk, fake } = make();
    const dto = await whole.read({ measure: false, refresh: false });

    expect(await calls(outsideLog)).toEqual([]);
    expect(await calls(homeLog)).toEqual([]);
    expect(existsSync(outsideLog)).toBe(false);
    expect(existsSync(homeLog)).toBe(false);
    expect(disk.homeSnapshot()).toBeNull();

    expect(dto.mode).toBe('apfs');
    expect(dto.volumeName).toBe('Macintosh HD');
    expect(dto.total).toBe(TOTAL);
    expect(dto.free).toBe(FREE);
    expect(dto.data).toBe(DATA);
    expect(dto.purgeable).toBe(PURGEABLE);
    expect(dto.snapshots).toEqual(['2026-11-07-101010']);
    expect(dto.phases).toEqual({ outside: 'idle', home: 'idle' });
    expect(dto.home).toBeNull();
    expect(dto.homePath).toBe(home);
    expect(dto.homeElsewhere).toBe(false);
    expect(dto.measuredAt).toBeNull();
    expect(dto.stale).toBe(false);

    const overhead = TOTAL - FREE - (SYSTEM + PREBOOT + RECOVERY + DATA + VM);
    expect(dto.overhead).toBe(overhead);
    expect(bytesOf(dto)).toEqual({ macos: SYSTEM, boot: PREBOOT + RECOVERY + overhead, vm: VM, pending: DATA });
    expect(segmentOf(dto, 'pending')!.group).toBe('unknown');
    closes(dto);

    // Só os comandos dos volumes, e o plutil sempre com o XML do diskutil.
    const files = new Set(fake.log.map((call) => call.file));
    expect(files).toEqual(new Set(['/usr/sbin/diskutil', '/usr/bin/plutil', '/usr/bin/osascript', '/usr/bin/tmutil']));
    expect(fake.log.filter((call) => call.file === '/usr/sbin/diskutil').map((call) => call.args.join(' '))).toEqual(
      expect.arrayContaining(['info -plist /', `info -plist ${dataRoot}`, 'apfs list -plist disk3'])
    );
  });

  it('com measure, o du de fora roda uma vez nas raízes do volume de dados, sem a pasta pessoal, /Volumes e /home', async () => {
    const { whole } = make();
    const progress: WholeDiskProgress[] = [];
    const dto = await whole.read({ measure: true, refresh: false }, (entry) => progress.push(entry));

    const outside = await calls(outsideLog);
    expect(outside).toHaveLength(1);
    const [args] = outside;
    expect(args.slice(0, 4)).toEqual(['-k', '-x', '-d', '4']);
    expect(new Set(args.slice(4))).toEqual(
      new Set(['Applications', 'Library', 'private', 'System', 'Users/Shared'].map((relative) => join(dataRoot, relative)))
    );
    for (const operand of args.slice(4)) {
      for (const forbidden of [home, join(dataRoot, 'Volumes'), join(dataRoot, 'home'), join(dataRoot, 'Users'), dataRoot]) {
        expect(operand === forbidden || forbidden.startsWith(operand + '/')).toBe(false);
      }
    }
    // A pasta pessoal fica com a passada do DiskMap, uma só.
    expect(await calls(homeLog)).toEqual([['-k', '-x', '-d', '3', home]]);

    expect(dto.phases).toEqual({ outside: 'done', home: 'done' });
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'outside', done: true }),
        expect.objectContaining({ phase: 'home', done: true }),
      ])
    );
    expect(dto.measuredAt).not.toBeNull();
    expect(dto.stale).toBe(false);
    expect(dto.drift).toBe(0);
  });

  it('com measure, cada segmento soma o que foi escrito nele, e a conta fecha com o total', async () => {
    const { whole } = make();
    const dto = await whole.read({ measure: true, refresh: false });

    const outsideTotal = d('Applications') + d('Library') + d('private') + d('System') + d('Users/Shared');
    const homeBytes = d('Users/ana');
    const overhead = TOTAL - FREE - (SYSTEM + PREBOOT + RECOVERY + DATA + VM);
    const expected: Partial<Record<WholeSegmentId, number>> = {
      macos: SYSTEM,
      boot: PREBOOT + RECOVERY + overhead,
      vm: VM + d('private/var/vm'),
      'system-data': d('private') - d('private/tmp') - d('private/var/vm') - d(VAR_FOLDER) + d('System') - d(SIM),
      unknown: DATA - outsideTotal - homeBytes,
      caches: d('Library/Caches') + d('private/tmp') + d(VAR_FOLDER),
      dev: d('Library/Developer') + d(SIM),
      home: homeBytes,
      apps: d('Applications') + d('Library') - d('Library/Developer') - d('Library/Caches'),
      others: d('Users/Shared'),
    };
    expect(bytesOf(dto)).toEqual(expected);
    // Na ordem fixa da barra.
    expect(dto.segments.map((segment) => segment.id)).toEqual(WHOLE_SEGMENTS.filter((id) => id in expected));
    closes(dto);

    // Cada pedaço medido tem pelo menos o que foi escrito, e no máximo uns blocos a mais por arquivo.
    const slack = (prefix: string) => 64 * 1024 + 16 * 1024 * [...written.keys()].filter((key) => key.startsWith(prefix + '/')).length;
    for (const prefix of [
      'Applications',
      'Library/Developer',
      'Library/Caches',
      'private/tmp',
      'private/var/vm',
      VAR_FOLDER,
      SIM,
      'Users/Shared',
      'Users/ana',
    ]) {
      expect(d(prefix)).toBeGreaterThanOrEqual(writtenUnder(prefix));
      expect(d(prefix)).toBeLessThanOrEqual(writtenUnder(prefix) + slack(prefix));
    }
    expect(segmentOf(dto, 'home')!.bytes).toBeGreaterThanOrEqual(writtenUnder('Users/ana'));
    expect(segmentOf(dto, 'others')!.bytes).toBeLessThan(writtenUnder('Users/ana'));

    // As partes saem com o caminho do Finder (firmlinks de reserva) e somam o segmento.
    for (const segment of dto.segments) expect(sum(segment.parts.map((part) => part.bytes))).toBe(segment.bytes);
    const paths = (id: WholeSegmentId) =>
      segmentOf(dto, id)!
        .parts.map((part) => part.path)
        .filter((path) => path !== undefined)
        .sort();
    expect(paths('apps')).toEqual(['/Applications', '/Library']);
    expect(paths('dev')).toEqual(['/Library/Developer', '/' + SIM]);
    expect(paths('caches')).toEqual(['/Library/Caches', '/private/tmp', '/' + VAR_FOLDER]);
    expect(paths('vm')).toEqual(['/private/var/vm']);
    expect(paths('system-data')).toEqual(['/System/Library', '/private']);
    expect(paths('others')).toEqual(['/Users/Shared']);
    expect(paths('home')).toEqual([home]);
    expect(segmentOf(dto, 'vm')!.parts.map((part) => part.source).sort()).toEqual(['apfs', 'du']);
    expect(segmentOf(dto, 'unknown')!.parts).toEqual([{ label: '', bytes: DATA - outsideTotal - homeBytes, source: 'rest' }]);

    // As fatias da pasta pessoal somam o segmento home.
    expect(dto.home).not.toBeNull();
    expect(sum(dto.home!.map((share) => share.bytes))).toBe(homeBytes);
    const shares = Object.fromEntries(dto.home!.map((share) => [share.id, share.bytes]));
    expect(shares.dev).toBe(d('Users/ana/Library/Developer'));
    expect(shares.caches).toBe(d('Users/ana/Library/Caches'));
    expect(shares.trash).toBe(d('Users/ana/.Trash'));
    expect(shares.rest).toBe(d('Users/ana') - d('Users/ana/Library') - d('Users/ana/.Trash'));
  });

  it('uma segunda chamada com measure enquanto a primeira corre reaproveita a mesma medida', async () => {
    const { whole } = make();
    const first = whole.read({ measure: true, refresh: false });
    const second = whole.read({ measure: true, refresh: false });
    const [a, b] = await Promise.all([first, second]);

    expect(await calls(outsideLog)).toHaveLength(1);
    expect(await calls(homeLog)).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a.phases).toEqual({ outside: 'done', home: 'done' });
    closes(a);
  });

  it('uma medida recente é reaproveitada, e refresh mede tudo de novo', async () => {
    const { whole } = make();
    const first = await whole.read({ measure: true, refresh: false });
    const again = await whole.read({ measure: true, refresh: false });
    expect(await calls(outsideLog)).toHaveLength(1);
    expect(await calls(homeLog)).toHaveLength(1);
    expect(again.measuredAt).toBe(first.measuredAt);

    await whole.read({ measure: true, refresh: true });
    expect(await calls(outsideLog)).toHaveLength(2);
    expect(await calls(homeLog)).toHaveLength(2);
  });

  it('markChanged depois da medida deixa stale true, e uma nova medida volta a valer', async () => {
    const { whole } = make();
    const measured = await whole.read({ measure: true, refresh: false });
    expect(measured.stale).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 5));
    whole.markChanged();
    const after = await whole.read({ measure: false, refresh: false });
    expect(after.stale).toBe(true);
    expect(after.measuredAt).toBe(measured.measuredAt);
    expect(bytesOf(after)).toEqual(bytesOf(measured));
    expect(await calls(outsideLog)).toHaveLength(1);

    // Pedir de novo depois da mudança não reaproveita a medida velha.
    const remeasured = await whole.read({ measure: true, refresh: false });
    expect(await calls(outsideLog)).toHaveLength(2);
    expect(await calls(homeLog)).toHaveLength(2);
    expect(remeasured.stale).toBe(false);
  });

  it('o volume de dados que cresce mais de 1 GB depois da medida também a deixa para trás', async () => {
    const { whole } = make();
    await whole.read({ measure: true, refresh: false });

    state.data = DATA + 500_000_000;
    skew += 6000; // passa da janela em que a leitura dos volumes é reaproveitada
    const small = await whole.read({ measure: false, refresh: false });
    expect(small.drift).toBe(500_000_000);
    expect(small.stale).toBe(false);
    closes(small);

    state.data = DATA + 2_500_000_000;
    skew += 6000;
    const big = await whole.read({ measure: false, refresh: false });
    expect(big.drift).toBe(2_500_000_000);
    expect(big.stale).toBe(true);
    expect(segmentOf(big, 'unknown')!.bytes - segmentOf(small, 'unknown')!.bytes).toBe(2_000_000_000);
    closes(big);
  });

  it('com measure, uma medida que ficou para trás por drift é refeita, sem precisar de refresh', async () => {
    const { whole } = make();
    await whole.read({ measure: true, refresh: false });
    expect(await calls(outsideLog)).toHaveLength(1);

    state.data = DATA + 2_500_000_000;
    skew += 6000;
    const remeasured = await whole.read({ measure: true, refresh: false });
    expect(await calls(outsideLog)).toHaveLength(2);
    expect(await calls(homeLog)).toHaveLength(2);
    expect(remeasured.drift).toBe(0);
    expect(remeasured.stale).toBe(false);
  });

  it('uma limpeza no meio da medida a deixa velha: a medida vale para a hora em que começou', async () => {
    const slow = join(root, 'bin', 'du-slow');
    await writeFile(slow, ['#!/bin/sh', 'sleep 0.4', 'exec /usr/bin/du "$@"', ''].join('\n'));
    await chmod(slow, 0o755);
    const { whole } = make({ du: slow, homeDu: slow });
    const reading = whole.read({ measure: true, refresh: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    whole.markChanged();
    const dto = await reading;
    expect(dto.measuredAt).not.toBeNull();
    expect(dto.stale).toBe(true);
  });

  it('o progresso diz pronto só da fase que terminou, e avisa a que foi reaproveitada', async () => {
    const events: WholeDiskProgress[] = [];
    const { whole } = make({ du: join(root, 'bin', 'no-such-du') });
    await whole.read({ measure: true, refresh: false }, (event) => events.push(event));
    const outside = events.filter((event) => event.phase === 'outside');
    expect(outside.some((event) => event.done)).toBe(false);
    expect(outside.at(-1)).toMatchObject({ failed: true });
    expect(events.filter((event) => event.phase === 'home').at(-1)).toMatchObject({ done: true });

    // Na volta, a pasta pessoal fresca não é medida de novo, mas a fase diz logo que está pronta.
    events.length = 0;
    await whole.read({ measure: true, refresh: false }, (event) => events.push(event));
    expect(await calls(homeLog)).toHaveLength(1);
    expect(events.find((event) => event.phase === 'home')).toMatchObject({ done: true, bytes: d('Users/ana') });
  });

  it('um diskutil que falha dá o modo basic, sem lançar', async () => {
    state.failDiskutil = true;
    const { whole, fake } = make();
    const dto = await whole.read({ measure: false, refresh: false });

    const rootFs = await statfs('/');
    expect(dto.mode).toBe('basic');
    expect(dto.total).toBe(rootFs.blocks * rootFs.bsize);
    expect(dto.volumeName).toBe('');
    expect(dto.purgeable).toBe(PURGEABLE);
    expect(dto.snapshots).toEqual(['2026-11-07-101010']);
    expect(dto.otherVolumes).toBe(0);
    expect(dto.overhead).toBe(0);
    expect(dto.phases).toEqual({ outside: 'idle', home: 'idle' });
    expect(dto.segments.every((segment) => ['macos', 'pending'].includes(segment.id))).toBe(true);
    expect(segmentOf(dto, 'pending')!.bytes).toBe(dto.data);
    for (const part of segmentOf(dto, 'macos')?.parts ?? []) expect(part.source).toBe('statfs');
    closes(dto);
    // O plutil nem chega a ser chamado.
    expect(fake.log.some((call) => call.file === '/usr/bin/plutil')).toBe(false);

    // Medir também funciona sem o APFS: o que sobra do volume de dados vira "não identificado".
    const measured = await whole.read({ measure: true, refresh: false });
    expect(measured.mode).toBe('basic');
    expect(measured.phases).toEqual({ outside: 'done', home: 'done' });
    expect(segmentOf(measured, 'home')!.bytes).toBe(d('Users/ana'));
    expect(segmentOf(measured, 'pending')).toBeUndefined();
    closes(measured);
  });

  it('um du inexistente dá phases.outside failed e mantém o pendente, sem lançar', async () => {
    const { whole } = make({ du: join(root, 'bin', 'no-such-du') });
    const dto = await whole.read({ measure: true, refresh: false });

    expect(dto.phases).toEqual({ outside: 'failed', home: 'done' });
    expect(dto.measuredAt).toBeNull();
    expect(dto.stale).toBe(false);
    const homeBytes = d('Users/ana');
    expect(bytesOf(dto)).toEqual({
      macos: SYSTEM,
      boot: PREBOOT + RECOVERY + dto.overhead,
      vm: VM,
      pending: DATA - homeBytes,
      home: homeBytes,
    });
    expect(segmentOf(dto, 'unknown')).toBeUndefined();
    closes(dto);
    expect(await calls(outsideLog)).toEqual([]);

    // A falha não fica presa: a próxima leitura sem medir ainda diz que falhou, e nada do de fora aparece.
    const later = await whole.read({ measure: false, refresh: false });
    expect(later.phases.outside).toBe('failed');
    expect(whole.knows('/Applications')).toBe(false);
  });

  it('knows() só aceita os caminhos que a última leitura mostrou, e /Users', async () => {
    const { whole } = make();
    expect(whole.knows('/Applications')).toBe(false);

    await whole.read({ measure: false, refresh: false });
    expect(whole.knows('/Users')).toBe(true);
    expect(whole.knows('/Applications')).toBe(false);
    expect(whole.knows(home)).toBe(false);

    const dto = await whole.read({ measure: true, refresh: false });
    expect(whole.knows('/Users')).toBe(true);
    for (const segment of dto.segments) {
      for (const part of segment.parts) if (part.path) expect(whole.knows(part.path)).toBe(true);
    }
    for (const share of dto.home ?? []) for (const entry of share.paths) expect(whole.knows(entry.path)).toBe(true);
    expect(whole.knows('/Applications')).toBe(true);
    expect(whole.knows('/Library/Developer')).toBe(true);
    expect(whole.knows(home)).toBe(true);
    expect(whole.knows(join(home, 'Library', 'Caches'))).toBe(true);

    // O que não apareceu fica de fora, mesmo existindo.
    for (const path of [
      '/',
      '/etc',
      '/Volumes',
      '/Users/ana',
      dataRoot,
      join(dataRoot, 'Applications'),
      join(dataRoot, 'Volumes', 'x'),
      join(dataRoot, 'home'),
      join(home, 'Documents'),
      join(home, 'Documents', 'report.pdf'),
      '/Applications/',
      '/Library/../etc',
    ]) {
      expect(whole.knows(path)).toBe(false);
    }
  });

  it('lê o arquivo de firmlinks: o que não é firmlink aparece pelo caminho do volume de dados', async () => {
    const firmlinks = join(root, 'firmlinks');
    await writeFile(firmlinks, '/Library\tLibrary\n/private\tprivate\n/Users\tUsers\n');
    const { whole } = make({ firmlinks });
    const dto = await whole.read({ measure: true, refresh: false });

    const apps = segmentOf(dto, 'apps')!.parts.map((part) => part.path).sort();
    expect(apps).toEqual(['/Library', join(dataRoot, 'Applications')].sort());
    expect(segmentOf(dto, 'dev')!.parts.map((part) => part.path).sort()).toEqual(['/Library/Developer', join(dataRoot, SIM)].sort());
    expect(whole.knows(join(dataRoot, 'Applications'))).toBe(true);
    expect(whole.knows('/Applications')).toBe(false);
    closes(dto);
  });
});
