import { describe, it, expect } from 'vitest';
import {
  appNameOf,
  groupProcesses,
  parseBattery,
  parseDefaultInterface,
  parseDiskStats,
  parseDuration,
  parseNetstat,
  parsePressure,
  parsePs,
  parseSwap,
  parseSysctl,
  parseVmStat,
} from './parse';

// Saídas reais de um MacBook Pro M4 Pro com 48 GB, encurtadas.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               84184.
Pages active:                            839722.
Pages inactive:                          830786.
Pages wired down:                        250930.
Pages purgeable:                          25249.
File-backed pages:                       482516.
Anonymous pages:                        1195413.
Pages occupied by compressor:           1077058.
`;

const PS = `  399  36.5 293008 12-09:17:25 2440:50.04 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
 7332  23,7 503072 01-21:10:10  39:13.66 claude
74142  17.8  83024    13:58:49  27:33.90 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
74100   2.0 120000    13:58:50   1:02.00 /Applications/Claude.app/Contents/MacOS/Claude
`;

const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        1000     0     500000     1000     0     500000     0
en0        1500  <Link#14>   50:f2:65:ef:8d:99 108113542     0 92314283920 60673305     0 25467114040     0
en0        1500  192.168.1     192.168.1.20    108113542     - 92314283920 60673305     -          -     -
utun4      1380  <Link#30>                       5000     0    7000000     4000     0    3000000     0
`;

const BATTERY_AS = `+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "CurrentCapacity" = 78
      "ExternalConnected" = Yes
      "IsCharging" = No
      "Temperature" = 3009
      "MaxCapacity" = 100
      "DesignCapacity" = 6249
      "CycleCount" = 30
      "AppleRawMaxCapacity" = 6199
      "BatteryData" = {"CycleCount"=29,"DesignCapacity"=1}
    }
`;

describe('perf parsing', () => {
  it('reads sysctl values by name', () => {
    const values = parseSysctl('kern.memorystatus_vm_pressure_level: 1\nvm.swapusage: total = 2048.00M  used = 1.50M\n');
    expect(values['kern.memorystatus_vm_pressure_level']).toBe('1');
    expect(values['vm.swapusage']).toBe('total = 2048.00M  used = 1.50M');
  });

  it('reads swap in bytes, with dot or comma decimals', () => {
    expect(parseSwap('total = 19456.00M  used = 18005.81M  free = 1450.19M  (encrypted)').used).toBeCloseTo(18005.81 * 1024 ** 2);
    expect(parseSwap('total = 19456,00M  used = 1,50G  free = 1450,19M').used).toBeCloseTo(1.5 * 1024 ** 3);
    expect(parseSwap(undefined)).toEqual({ total: 0, used: 0 });
  });

  it('maps the kernel memory pressure level', () => {
    expect(parsePressure('1')).toBe('normal');
    expect(parsePressure('2')).toBe('warning');
    expect(parsePressure('4')).toBe('critical');
    expect(parsePressure(undefined)).toBe('normal');
  });

  it('counts memory like Activity Monitor', () => {
    const { used, cached } = parseVmStat(VM_STAT);
    expect(used).toBe((1195413 - 25249 + 250930 + 1077058) * 16384);
    expect(cached).toBe((482516 + 25249) * 16384);
  });

  it('parses ps durations, including minutes past 59 and days', () => {
    expect(parseDuration('13:58:49')).toBe(13 * 3600 + 58 * 60 + 49);
    expect(parseDuration('12-09:17:25')).toBe(12 * 86400 + 9 * 3600 + 17 * 60 + 25);
    expect(parseDuration('2440:50.04')).toBeCloseTo(2440 * 60 + 50.04);
    expect(parseDuration('garbage')).toBe(0);
  });

  it('parses ps rows with spaces in the command', () => {
    const rows = parsePs(PS);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ pid: 399, cpu: 36.5, memory: 293008 * 1024 });
    expect(rows[1].cpu).toBe(23.7);
    expect(rows[2].command).toBe('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper');
  });

  it('names a process after the app that contains it', () => {
    expect(appNameOf('/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper')).toBe('Claude');
    expect(appNameOf('/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer')).toBe('WindowServer');
    expect(appNameOf('claude')).toBe('claude');
  });

  it('adds up helpers under their app', () => {
    const claude = groupProcesses(parsePs(PS)).find((group) => group.name === 'Claude')!;
    expect(claude.count).toBe(2);
    expect(claude.cpu).toBeCloseTo(19.8);
    expect(claude.memory).toBe((83024 + 120000) * 1024);
    expect(claude.system).toBe(false);
  });

  it('tells macOS processes apart from what the person opened', () => {
    const groups = groupProcesses(parsePs(PS));
    expect(groups.find((group) => group.name === 'WindowServer')!.system).toBe(true);
    expect(groups.find((group) => group.name === 'claude')!.system).toBe(false);
  });

  it('sums disk bytes across drives', () => {
    const output = `"Statistics" = {"Bytes (Read)"=0,"Bytes (Write)"=0}
"Statistics" = {"Operations (Write)"=8,"Bytes (Read)"=2027389460480,"Bytes (Write)"=2073456467968}`;
    expect(parseDiskStats(output)).toEqual({ read: 2027389460480, write: 2073456467968 });
  });

  it('reads the default route interface', () => {
    expect(parseDefaultInterface('   route to: default\n  interface: en0\n')).toBe('en0');
    expect(parseDefaultInterface('route: writing to routing socket: not in table')).toBeNull();
  });

  it('reads interface counters, with and without a hardware address', () => {
    expect(parseNetstat(NETSTAT, 'en0')).toEqual({ received: 92314283920, sent: 25467114040 });
    expect(parseNetstat(NETSTAT, 'utun4')).toEqual({ received: 7000000, sent: 3000000 });
    expect(parseNetstat(NETSTAT, 'en9')).toBeNull();
  });

  it('reads an Apple Silicon battery from the top-level keys only', () => {
    expect(parseBattery(BATTERY_AS)).toEqual({
      percent: 78,
      charging: false,
      plugged: true,
      cycles: 30,
      health: 6199 / 6249,
      temperature: 30.09,
    });
  });

  it('reads an Intel battery, where capacities come in mAh', () => {
    const intel = `"CurrentCapacity" = 3000\n"MaxCapacity" = 6000\n"DesignCapacity" = 7500\n"CycleCount" = 812\n"IsCharging" = Yes`;
    expect(parseBattery(intel)).toMatchObject({ percent: 50, charging: true, cycles: 812, health: 0.8 });
  });

  it('has no battery on a desktop Mac', () => {
    expect(parseBattery('')).toBeNull();
  });
});
