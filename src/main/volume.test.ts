import { describe, it, expect } from 'vitest';
import { parseCapacity, parseLocalSnapshots, purgeableBytes } from './volume';

describe('volume', () => {
  it('reads the capacities printed by the JXA script', () => {
    expect(parseCapacity('{"available":110332272640,"important":121602000880}')).toEqual({
      available: 110332272640,
      important: 121602000880,
    });
  });

  it('refuses output it cannot trust', () => {
    expect(parseCapacity('')).toBeNull();
    expect(parseCapacity('execution error: -1728')).toBeNull();
    expect(parseCapacity('{"available":1}')).toBeNull();
    expect(parseCapacity('{"available":"1","important":"2"}')).toBeNull();
  });

  it('counts as purgeable what Finder sees as available beyond the free space', () => {
    expect(purgeableBytes({ available: 110_332_272_640, important: 121_602_000_880 })).toBe(11_269_728_240);
  });

  it('never reports negative purgeable space', () => {
    expect(purgeableBytes({ available: 200, important: 100 })).toBe(0);
  });

  it('lists local snapshot dates from tmutil', () => {
    const output = [
      'Snapshots for disk /:',
      'com.apple.TimeMachine.2026-10-11-091204.local',
      'com.apple.TimeMachine.2026-10-12-193412.local',
    ].join('\n');

    expect(parseLocalSnapshots(output)).toEqual(['2026-10-11-091204', '2026-10-12-193412']);
  });

  it('finds no snapshots when there are none', () => {
    expect(parseLocalSnapshots('Snapshots for disk /:\n')).toEqual([]);
  });
});
