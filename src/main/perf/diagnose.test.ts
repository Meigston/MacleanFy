import { describe, it, expect } from 'vitest';
import { diagnose, type DiagnosisInput } from './diagnose';
import { groupProcesses, type ProcessRow } from './parse';

const GIB = 1024 ** 3;
const HOUR = 3600;

function row(command: string, partial: Partial<ProcessRow> = {}): ProcessRow {
  return { pid: 1, cpu: 1, memory: GIB, elapsed: HOUR, cpuTime: 60, command, ...partial };
}

function input(partial: Partial<DiagnosisInput> = {}, processes: ProcessRow[] = []): DiagnosisInput {
  return {
    memory: { total: 32 * GIB, pressure: 'normal', swapUsed: 0 },
    load: [1, 1, 1],
    cores: 8,
    processes,
    groups: groupProcesses(processes),
    thermal: 'nominal',
    uptime: HOUR,
    ...partial,
  };
}

const APPS = [
  row('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', { memory: 6 * GIB, cpu: 40 }),
  row('/Applications/Xcode.app/Contents/MacOS/Xcode', { memory: 4 * GIB, cpu: 10 }),
  row('/Applications/Slack.app/Contents/MacOS/Slack', { memory: 1 * GIB, cpu: 5 }),
  row('/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer', { memory: 9 * GIB, cpu: 90 }),
  row('kernel_task', { memory: 8 * GIB, cpu: 80 }),
];

describe('diagnose', () => {
  it('finds nothing on a quiet Mac', () => {
    expect(diagnose(input({}, APPS))).toEqual([]);
  });

  it('blames the apps the person opened, never macOS itself, when memory runs out', () => {
    const findings = diagnose(input({ memory: { total: 32 * GIB, pressure: 'critical', swapUsed: 10 * GIB } }, APPS));
    expect(findings).toEqual([{ id: 'memory', severity: 'critical', apps: ['Google Chrome', 'Xcode', 'Slack'] }]);
  });

  it('flags heavy swap even when pressure is back to normal', () => {
    const findings = diagnose(input({ memory: { total: 48 * GIB, pressure: 'normal', swapUsed: 18 * GIB } }, APPS));
    expect(findings).toEqual([{ id: 'swap', severity: 'warning', used: 18 * GIB, apps: ['Google Chrome', 'Xcode', 'Slack'] }]);
  });

  it('ignores small swap', () => {
    expect(diagnose(input({ memory: { total: 8 * GIB, pressure: 'normal', swapUsed: 1.5 * GIB } }))).toEqual([]);
    expect(diagnose(input({ memory: { total: 64 * GIB, pressure: 'normal', swapUsed: 10 * GIB } }))).toEqual([]);
  });

  it('flags a CPU busy for minutes, not a short spike', () => {
    expect(diagnose(input({ load: [12, 4, 2] }, APPS))).toEqual([]);
    expect(diagnose(input({ load: [9, 8, 6] }, APPS))).toEqual([
      { id: 'cpu', severity: 'warning', load: 8, cores: 8, apps: ['Google Chrome', 'Xcode', 'Slack'] },
    ]);
  });

  it('finds a process stuck in a loop for hours', () => {
    const stuck = row('/Applications/Some Sync.app/Contents/MacOS/Some Sync', {
      elapsed: 5 * HOUR,
      cpuTime: 4 * HOUR,
      cpu: 95,
    });
    expect(diagnose(input({}, [...APPS, stuck]))).toEqual([
      { id: 'runaway', severity: 'warning', app: 'Some Sync', hours: 5, average: 80 },
    ]);
  });

  it('does not call a long-running but mostly idle process a runaway', () => {
    const editor = row('/Applications/Editor.app/Contents/MacOS/Editor', { elapsed: 48 * HOUR, cpuTime: 2 * HOUR, cpu: 60 });
    const burst = row('/Applications/Render.app/Contents/MacOS/Render', { elapsed: HOUR, cpuTime: HOUR, cpu: 100 });
    expect(diagnose(input({}, [editor, burst]))).toEqual([]);
  });

  it('explains Spotlight indexing instead of calling it a runaway', () => {
    const spotlight = [
      row('/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores', { cpu: 45, elapsed: 9 * HOUR, cpuTime: 8 * HOUR }),
      row('/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mdworker_shared', { cpu: 30 }),
    ];
    expect(diagnose(input({}, spotlight))).toEqual([{ id: 'spotlight', severity: 'info', cpu: 75 }]);
  });

  it('reports a hot Mac', () => {
    expect(diagnose(input({ thermal: 'fair' }))).toEqual([]);
    expect(diagnose(input({ thermal: 'serious' }))).toEqual([{ id: 'thermal', severity: 'warning' }]);
    expect(diagnose(input({ thermal: 'critical' }))).toEqual([{ id: 'thermal', severity: 'critical' }]);
  });

  it('suggests a restart after a week, and insists after two', () => {
    expect(diagnose(input({ uptime: 6.9 * 24 * HOUR }))).toEqual([]);
    expect(diagnose(input({ uptime: 12 * 24 * HOUR }))).toEqual([{ id: 'uptime', severity: 'info', days: 12 }]);
    expect(diagnose(input({ uptime: 15 * 24 * HOUR }))).toEqual([{ id: 'uptime', severity: 'warning', days: 15 }]);
  });

  it('puts the most severe findings first', () => {
    const findings = diagnose(
      input({ uptime: 8 * 24 * HOUR, thermal: 'critical', memory: { total: 32 * GIB, pressure: 'warning', swapUsed: 0 } }, APPS)
    );
    expect(findings.map((finding) => finding.severity)).toEqual(['critical', 'warning', 'info']);
  });
});
