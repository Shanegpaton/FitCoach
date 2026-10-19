import { describe, expect, it, vi } from 'vitest';
import { typeRemoteText } from './remoteKeyboard';

describe('phone keyboard relay', () => {
  it('sends ASCII and Unicode characters as individual VNC key events', () => {
    const sendKey = vi.fn();
    typeRemoteText({ sendKey }, 'A@é💪');
    expect(sendKey.mock.calls).toEqual([
      [65, null], [64, null], [233, null], [0x01000000 + 0x1f4aa, null],
    ]);
  });
});
