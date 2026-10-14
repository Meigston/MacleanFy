import { describe, it, expect } from 'vitest';
import type { PlistReading } from './startup';
import { isSafeSystemPath, removalScript, systemFilesOf } from './system-files';

const ONEDRIVE = { path: '/Applications/OneDrive.app', bundleId: 'com.microsoft.OneDrive' };

function plist(scope: 'user' | 'agent' | 'daemon', path: string, reading: Partial<PlistReading>) {
  return { scope, path, reading: { path, ...reading } };
}

describe('system files', () => {
  it('accepts only plain names straight inside the three folders', () => {
    expect(isSafeSystemPath('/Library/LaunchDaemons/com.microsoft.OneDriveUpdaterDaemon.plist')).toBe(true);
    expect(isSafeSystemPath('/Library/PrivilegedHelperTools/us.zoom.ZoomDaemon')).toBe(true);
    expect(isSafeSystemPath('/Library/LaunchDaemons/sub/x.plist')).toBe(false);
    expect(isSafeSystemPath('/Library/LaunchDaemons/../../etc/hosts')).toBe(false);
    expect(isSafeSystemPath('/Library/LaunchDaemons/-rf')).toBe(false);
    expect(isSafeSystemPath('/Library/LaunchDaemons/a b.plist')).toBe(false);
    expect(isSafeSystemPath("/Library/LaunchDaemons/a';rm -rf ~;'.plist")).toBe(false);
    expect(isSafeSystemPath('/System/Library/LaunchDaemons/com.apple.x.plist')).toBe(false);
  });

  it('finds the jobs whose program lives inside the app', () => {
    const files = systemFilesOf(ONEDRIVE, [
      plist('daemon', '/Library/LaunchDaemons/com.microsoft.OneDriveUpdaterDaemon.plist', {
        label: 'com.microsoft.OneDriveUpdaterDaemon',
        program: '/Applications/OneDrive.app/Contents/OneDriveUpdaterDaemon.xpc/Contents/MacOS/OneDriveUpdaterDaemon',
      }),
      plist('agent', '/Library/LaunchAgents/com.microsoft.SyncReporter.plist', {
        label: 'com.microsoft.SyncReporter',
        program: '/Applications/OneDrive.app/Contents/SyncReporter.app/Contents/MacOS/SyncReporter',
      }),
      // Outro app cujo nome começa igual não entra.
      plist('agent', '/Library/LaunchAgents/com.other.plist', {
        label: 'com.other',
        program: '/Applications/OneDrive.app.backup/helper',
      }),
      // Os da pasta pessoal ficam com o desinstalador comum.
      plist('user', '/Users/ana/Library/LaunchAgents/com.microsoft.OneDrive.plist', {
        label: 'com.microsoft.OneDrive',
        program: '/Applications/OneDrive.app/Contents/MacOS/OneDrive',
      }),
    ]);

    expect(files).toEqual([
      {
        path: '/Library/LaunchDaemons/com.microsoft.OneDriveUpdaterDaemon.plist',
        label: 'com.microsoft.OneDriveUpdaterDaemon',
        scope: 'daemon',
      },
      { path: '/Library/LaunchAgents/com.microsoft.SyncReporter.plist', label: 'com.microsoft.SyncReporter', scope: 'agent' },
    ]);
  });

  it('takes the privileged helper of a job the plist says belongs to the app', () => {
    const files = systemFilesOf({ path: '/Applications/zoom.us.app', bundleId: 'us.zoom.xos' }, [
      plist('daemon', '/Library/LaunchDaemons/us.zoom.ZoomDaemon.plist', {
        label: 'us.zoom.ZoomDaemon',
        program: '/Library/PrivilegedHelperTools/us.zoom.ZoomDaemon',
        bundleIds: ['us.zoom.xos'],
      }),
    ]);

    expect(files).toEqual([
      { path: '/Library/LaunchDaemons/us.zoom.ZoomDaemon.plist', label: 'us.zoom.ZoomDaemon', scope: 'daemon' },
      { path: '/Library/PrivilegedHelperTools/us.zoom.ZoomDaemon', label: null, scope: 'helper' },
    ]);
  });

  it('leaves a job alone when nothing ties it to the app', () => {
    const files = systemFilesOf({ path: '/Applications/Docker.app', bundleId: 'com.docker.docker' }, [
      plist('daemon', '/Library/LaunchDaemons/com.docker.vmnetd.plist', {
        label: 'com.docker.vmnetd',
        program: '/Library/PrivilegedHelperTools/com.docker.vmnetd',
      }),
    ]);

    expect(files).toEqual([]);
  });

  it('skips labels the shell would read as something else', () => {
    const files = systemFilesOf(ONEDRIVE, [
      plist('daemon', '/Library/LaunchDaemons/com.microsoft.x.plist', {
        label: 'com.microsoft.x; rm -rf /',
        program: '/Applications/OneDrive.app/Contents/x',
      }),
    ]);

    expect(files).toEqual([]);
  });

  it('builds one command that stops each job before deleting its files', () => {
    const script = removalScript(
      [
        { path: '/Library/LaunchDaemons/us.zoom.ZoomDaemon.plist', label: 'us.zoom.ZoomDaemon', scope: 'daemon' },
        { path: '/Library/PrivilegedHelperTools/us.zoom.ZoomDaemon', label: null, scope: 'helper' },
        { path: '/Library/LaunchAgents/com.microsoft.SyncReporter.plist', label: 'com.microsoft.SyncReporter', scope: 'agent' },
        { path: '/etc/hosts', label: null, scope: 'helper' },
      ],
      501
    );

    expect(script).toBe(
      [
        '/bin/launchctl bootout system/us.zoom.ZoomDaemon 2>/dev/null || true',
        '/bin/rm -f /Library/LaunchDaemons/us.zoom.ZoomDaemon.plist',
        '/bin/rm -f /Library/PrivilegedHelperTools/us.zoom.ZoomDaemon',
        '/bin/launchctl bootout gui/501/com.microsoft.SyncReporter 2>/dev/null || true',
        '/bin/rm -f /Library/LaunchAgents/com.microsoft.SyncReporter.plist',
      ].join('; ')
    );
    expect(removalScript([], 501)).toBe('');
    expect(removalScript([{ path: '/Library/LaunchDaemons/a.plist', label: 'a', scope: 'daemon' }], NaN)).toBe('');
  });
});
