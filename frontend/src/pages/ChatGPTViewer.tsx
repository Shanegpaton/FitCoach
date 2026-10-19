import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import type RFB from '@novnc/novnc';
import { chatgptVmUrl } from '../chatgptVm';
import { typeRemoteText } from '../remoteKeyboard';

export function ChatGPTViewer({ token, onClose }: { token: string; onClose: () => void }) {
  const target = useRef<HTMLDivElement>(null);
  const remote = useRef<RFB | null>(null);
  const [status, setStatus] = useState('Opening the OpenAI sign-in page…');
  const [ready, setReady] = useState(false);

  const sendText = (value: string) => typeRemoteText(remote.current, value);
  const sendControl = (keysym: number) => remote.current?.sendKey(keysym, null);
  const handleInput = (event: FormEvent<HTMLInputElement>) => {
    if ((event.nativeEvent as InputEvent).isComposing) return;
    const input = event.currentTarget;
    if ((event.nativeEvent as InputEvent).inputType?.startsWith('delete')) sendControl(0xff08);
    else if (input.value) sendText(input.value);
    input.value = '';
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const keysym = event.key === 'Enter' ? 0xff0d : event.key === 'Tab' ? 0xff09
      : event.key === 'Backspace' ? 0xff08 : null;
    if (keysym === null) return;
    event.preventDefault();
    sendControl(keysym);
  };

  useEffect(() => {
    const targetNode = target.current;
    if (!targetNode) return;
    let disposed = false;
    let disconnect: (() => void) | undefined;
    const connect = async () => {
      try {
        const { default: RFB } = await import('@novnc/novnc');
        if (disposed) return;
        const wsUrl = new URL('/v1/viewer', chatgptVmUrl);
        wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const rfb = new RFB(targetNode, wsUrl.toString(), { wsProtocols: [`fitcoach.${token}`] });
        remote.current = rfb;
        disconnect = () => rfb.disconnect();
        rfb.scaleViewport = true;
        rfb.focusOnClick = true;
        rfb.addEventListener('connect', () => { setReady(true); setStatus('VM browser connected. Complete sign-in on the OpenAI page below.'); });
        rfb.addEventListener('disconnect', () => { if (!disposed) { setReady(false); setStatus('Browser connection closed. Return to Settings and try again.'); } });
        rfb.addEventListener('securityfailure', () => setStatus('The browser connection was rejected. Return to Settings and try again.'));
      } catch {
        if (!disposed) setStatus('Could not open the VM browser. Return to Settings and try again.');
      }
    };
    void connect();
    return () => { disposed = true; remote.current = null; disconnect?.(); };
  }, [token]);

  return <div className="chatgpt-viewer" role="dialog" aria-modal="true" aria-label="ChatGPT sign-in">
    <div className="chatgpt-viewer-header"><div><strong>Connect ChatGPT</strong><span>Sign in and review permission on OpenAI’s page.</span></div><button className="icon-button" aria-label="Close ChatGPT sign-in" onClick={onClose}><X size={20} /></button></div>
    <p className="chatgpt-viewer-status" role="status">{status}</p>
    <div className="chatgpt-viewer-screen" ref={target} aria-label="Interactive OpenAI sign-in browser" />
    <div className="chatgpt-viewer-keyboard"><label htmlFor="chatgpt-remote-keyboard">Tap a field on OpenAI’s page, then type here with your phone keyboard.</label>
      <input id="chatgpt-remote-keyboard" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
        placeholder="Type into selected OpenAI field" disabled={!ready} onFocus={() => remote.current?.blur()}
        onInput={handleInput} onCompositionEnd={event => { sendText(event.currentTarget.value); event.currentTarget.value = ''; }}
        onKeyDown={handleKeyDown} />
      <div className="chatgpt-viewer-keys"><button type="button" className="button secondary" disabled={!ready} onClick={() => sendControl(0xff08)}>Backspace</button>
        <button type="button" className="button secondary" disabled={!ready} onClick={() => sendControl(0xff09)}>Tab</button>
        <button type="button" className="button secondary" disabled={!ready} onClick={() => sendControl(0xff0d)}>Enter</button></div>
    </div>
  </div>;
}
