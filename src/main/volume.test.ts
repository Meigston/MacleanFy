import { describe, it, expect } from 'vitest';
import {
  BOOT_ROLES,
  parseApfsContainer,
  parseCapacity,
  parseDiskInfo,
  parseFirmlinks,
  parseLocalSnapshots,
  purgeableBytes,
  volumeOf,
  type ApfsVolume,
} from './volume';

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

// `diskutil info -plist /` depois do `plutil -convert json`, anonimizado.
const ROOT_INFO = {
  DeviceIdentifier: 'disk3s1s1',
  DeviceNode: '/dev/disk3s1s1',
  APFSContainerReference: 'disk3',
  APFSVolumeGroupID: '11111111-2222-3333-4444-555555555555',
  VolumeName: 'Macintosh HD',
  FilesystemType: 'apfs',
  FilesystemName: 'APFS',
  TotalSize: 994662584320,
  Sealed: 'Yes',
};

describe('parseDiskInfo', () => {
  it('reads the device, the container, the name, the type and the volume group', () => {
    expect(parseDiskInfo(ROOT_INFO)).toEqual({
      device: 'disk3s1s1',
      container: 'disk3',
      volumeName: 'Macintosh HD',
      fsType: 'apfs',
      groupId: '11111111-2222-3333-4444-555555555555',
    });
  });

  it('falls back to the file system name and leaves out what is missing', () => {
    expect(parseDiskInfo({ DeviceIdentifier: 'disk4s1', FilesystemName: 'ExFAT' })).toEqual({
      device: 'disk4s1',
      container: null,
      volumeName: '',
      fsType: 'ExFAT',
      groupId: null,
    });
  });

  it('takes empty and non-text fields as missing', () => {
    expect(
      parseDiskInfo({
        DeviceIdentifier: 'disk3s5',
        APFSContainerReference: '',
        VolumeName: 7,
        FilesystemType: '',
        FilesystemName: null,
        APFSVolumeGroupID: '',
      })
    ).toEqual({ device: 'disk3s5', container: null, volumeName: '', fsType: '', groupId: null });
  });

  it('refuses what has no device', () => {
    expect(parseDiskInfo(null)).toBeNull();
    expect(parseDiskInfo(undefined)).toBeNull();
    expect(parseDiskInfo('disk3s1s1')).toBeNull();
    expect(parseDiskInfo([ROOT_INFO])).toBeNull();
    expect(parseDiskInfo({})).toBeNull();
    expect(parseDiskInfo({ DeviceIdentifier: '' })).toBeNull();
    expect(parseDiskInfo({ DeviceIdentifier: 3 })).toBeNull();
  });
});

// `diskutil apfs list -plist` depois do `plutil -convert json`, anonimizado.
const APFS_LIST = {
  Containers: [
    {
      ContainerReference: 'disk1',
      CapacityCeiling: 524288000,
      CapacityFree: 500000000,
      Volumes: [
        { DeviceIdentifier: 'disk1s1', Name: 'iSCPreboot', Roles: ['Preboot'], CapacityInUse: 7000000 },
        { DeviceIdentifier: 'disk1s2', Name: 'xART', Roles: ['xART'], CapacityInUse: 6000000 },
      ],
    },
    {
      APFSContainerUUID: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      ContainerReference: 'disk3',
      CapacityCeiling: 994662584320,
      CapacityFree: 650000000000,
      Volumes: [
        {
          APFSVolumeUUID: '00000000-0000-0000-0000-000000000001',
          DeviceIdentifier: 'disk3s1',
          Name: 'Macintosh HD',
          Roles: ['System'],
          CapacityInUse: 11200000000,
        },
        { DeviceIdentifier: 'disk3s5', Name: 'Macintosh HD - Data', Roles: ['Data'], CapacityInUse: 320000000000 },
        { DeviceIdentifier: 'disk3s6', Name: 'VM', Roles: ['VM'], CapacityInUse: 2147483648 },
        { DeviceIdentifier: 'disk3s7', Roles: 'System', CapacityInUse: 1 },
        { DeviceIdentifier: 'disk3s8', Name: 'Mixed', Roles: ['Data', 7, null], CapacityInUse: 0 },
        { Name: 'NoDevice', Roles: [], CapacityInUse: 1 },
        { DeviceIdentifier: 'disk3s9', Name: 'Negative', Roles: [], CapacityInUse: -1 },
        { DeviceIdentifier: 'disk3s10', Name: 'Text', Roles: [], CapacityInUse: '100' },
        { DeviceIdentifier: 'disk3s11', Name: 'Missing', Roles: [] },
        'garbage',
        null,
      ],
    },
    {
      ContainerReference: 'disk5',
      CapacityCeiling: 1000,
      CapacityFree: 10,
      Volumes: [{ DeviceIdentifier: 'disk5s1', Name: 'Installer', Roles: [], CapacityInUse: 990 }],
    },
  ],
};

describe('parseApfsContainer', () => {
  it('reads only the container asked for, with its volumes', () => {
    expect(parseApfsContainer(APFS_LIST, 'disk3')).toEqual({
      reference: 'disk3',
      ceiling: 994662584320,
      free: 650000000000,
      volumes: [
        { device: 'disk3s1', name: 'Macintosh HD', roles: ['System'], inUse: 11200000000 },
        { device: 'disk3s5', name: 'Macintosh HD - Data', roles: ['Data'], inUse: 320000000000 },
        { device: 'disk3s6', name: 'VM', roles: ['VM'], inUse: 2147483648 },
        // Sem nome, o volume leva o dispositivo; papéis que não são lista ou texto ficam de fora.
        { device: 'disk3s7', name: 'disk3s7', roles: [], inUse: 1 },
        { device: 'disk3s8', name: 'Mixed', roles: ['Data'], inUse: 0 },
      ],
    });
  });

  it('never mixes in the volumes of another container', () => {
    const devices = parseApfsContainer(APFS_LIST, 'disk3')!.volumes.map((volume) => volume.device);
    expect(devices.some((device) => device.startsWith('disk1') || device.startsWith('disk5'))).toBe(false);
    expect(parseApfsContainer(APFS_LIST, 'disk1')!.volumes.map((volume) => volume.name)).toEqual(['iSCPreboot', 'xART']);
  });

  it('refuses a container it cannot trust', () => {
    expect(parseApfsContainer(APFS_LIST, 'disk9')).toBeNull();
    expect(parseApfsContainer(null, 'disk3')).toBeNull();
    expect(parseApfsContainer([], 'disk3')).toBeNull();
    expect(parseApfsContainer({}, 'disk3')).toBeNull();
    expect(parseApfsContainer({ Containers: 'disk3' }, 'disk3')).toBeNull();
    const one = (container: Record<string, unknown>) => ({ Containers: [{ ContainerReference: 'disk3', ...container }] });
    expect(parseApfsContainer(one({ CapacityFree: 1, Volumes: [] }), 'disk3')).toBeNull();
    expect(parseApfsContainer(one({ CapacityCeiling: 10, Volumes: [] }), 'disk3')).toBeNull();
    expect(parseApfsContainer(one({ CapacityCeiling: -10, CapacityFree: 1, Volumes: [] }), 'disk3')).toBeNull();
    expect(parseApfsContainer(one({ CapacityCeiling: '10', CapacityFree: 1, Volumes: [] }), 'disk3')).toBeNull();
    expect(parseApfsContainer(one({ CapacityCeiling: 10, CapacityFree: 1 }), 'disk3')).toBeNull();
    expect(parseApfsContainer(one({ CapacityCeiling: 10, CapacityFree: 1, Volumes: [] }), 'disk3')).toEqual({
      reference: 'disk3',
      ceiling: 10,
      free: 1,
      volumes: [],
    });
  });
});

describe('volumeOf', () => {
  const volume = (device: string): ApfsVolume => ({ device, name: device, roles: [], inUse: 1 });
  // disk3s10 antes de disk3s1: a ordem da lista não pode decidir.
  const volumes = [volume('disk3s10'), volume('disk3s1'), volume('disk3s5')];

  it('finds the volume by its own device', () => {
    expect(volumeOf('disk3s5', volumes)?.device).toBe('disk3s5');
    expect(volumeOf('disk3s1', volumes)?.device).toBe('disk3s1');
    expect(volumeOf('disk3s10', volumes)?.device).toBe('disk3s10');
  });

  it('finds the volume of a sealed snapshot, never a volume whose name only starts the same', () => {
    expect(volumeOf('disk3s1s1', volumes)?.device).toBe('disk3s1');
    expect(volumeOf('disk3s1s12', volumes)?.device).toBe('disk3s1');
    expect(volumeOf('disk3s10s1', volumes)?.device).toBe('disk3s10');
    expect(volumeOf('disk3s1s1', [volume('disk3s10')])).toBeNull();
    expect(volumeOf('disk33s1s1', [volume('disk3s1')])).toBeNull();
  });

  it('finds nothing for an unknown device', () => {
    expect(volumeOf('disk3s2', volumes)).toBeNull();
    expect(volumeOf('disk3', volumes)).toBeNull();
    expect(volumeOf('disk3s1s', volumes)).toBeNull();
    expect(volumeOf('disk3s1sx', volumes)).toBeNull();
    expect(volumeOf('', volumes)).toBeNull();
    expect(volumeOf('disk3s1', [])).toBeNull();
  });
});

describe('BOOT_ROLES', () => {
  it('lists the volumes the Mac starts, recovers and updates from', () => {
    expect([...BOOT_ROLES].sort()).toEqual(['Hardware', 'Preboot', 'Recovery', 'Update', 'xART']);
  });
});

describe('parseFirmlinks', () => {
  it('reads the data volume folder of each line, as macOS ships the file', () => {
    const content = [
      '/AppleInternal\tAppleInternal',
      '/Applications\tApplications',
      '/System/Library/Caches\tSystem/Library/Caches',
      '/usr/local\tusr/local',
      '/usr/libexec/cups\tusr/libexec/cups',
      '',
    ].join('\n');
    expect(parseFirmlinks(content)).toEqual([
      'AppleInternal',
      'Applications',
      'System/Library/Caches',
      'usr/local',
      'usr/libexec/cups',
    ]);
  });

  it('trims spaces, carriage returns and slashes around the folder', () => {
    expect(parseFirmlinks('/opt\t/opt/\r\n/Users\t Users \n/cores\tcores//')).toEqual(['opt', 'Users', 'cores']);
  });

  it('skips blank lines and lines without a folder', () => {
    expect(parseFirmlinks('')).toEqual([]);
    expect(parseFirmlinks('\n\n')).toEqual([]);
    expect(parseFirmlinks('/Applications\n/Library\t\n/opt\t/\n# comentário')).toEqual([]);
  });
});
