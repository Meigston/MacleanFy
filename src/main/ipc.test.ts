import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, clipboard: {}, ipcMain: {}, nativeImage: {}, shell: {} }));

import { SUPPORT } from '../shared/support';
import { isAllowedExternal } from './ipc';

describe('isAllowedExternal', () => {
  it('allows the links the app itself points to', () => {
    expect(isAllowedExternal('https://github.com/Meigston/MacleanFy')).toBe(true);
    expect(isAllowedExternal('https://github.com/guhcostan/mac-cleaner-cli')).toBe(true);
    expect(isAllowedExternal('https://www.linkedin.com/in/meigston/')).toBe(true);
    expect(isAllowedExternal('https://airdroidfy.com/?ref=macleanfy')).toBe(true);
    expect(isAllowedExternal(SUPPORT.stripe)).toBe(true);
  });

  it('refuses look-alike hosts, other schemes and anything else', () => {
    expect(isAllowedExternal('https://airdroidfy.com.example.org/')).toBe(false);
    expect(isAllowedExternal('http://airdroidfy.com/')).toBe(false);
    expect(isAllowedExternal('https://www.linkedin.com/in/someone-else/')).toBe(false);
    expect(isAllowedExternal('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternal('https://example.org/')).toBe(false);
  });
});
