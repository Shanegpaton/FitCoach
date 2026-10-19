export interface RemoteKeyboard { sendKey(keysym: number, code: string | null): void }

export function typeRemoteText(remote: RemoteKeyboard | null, value: string): void {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    remote?.sendKey(point <= 0xff ? point : 0x01000000 + point, null);
  }
}
