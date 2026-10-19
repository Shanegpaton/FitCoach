import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { chatgptVmUrl } from '../chatgptVm';

export function ChatGPTViewer({ token, onClose }: { token: string; onClose: () => void }) {
  const target = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Opening the OpenAI sign-in page…');

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
        disconnect = () => rfb.disconnect();
        rfb.scaleViewport = true;
        rfb.focusOnClick = true;
        rfb.addEventListener('connect', () => setStatus('VM browser connected. Complete sign-in on the OpenAI page below.'));
        rfb.addEventListener('disconnect', () => { if (!disposed) setStatus('Browser connection closed. Return to Settings and try again.'); });
        rfb.addEventListener('securityfailure', () => setStatus('The browser connection was rejected. Return to Settings and try again.'));
      } catch {
        if (!disposed) setStatus('Could not open the VM browser. Return to Settings and try again.');
      }
    };
    void connect();
    return () => { disposed = true; disconnect?.(); };
  }, [token]);

  return <div className="chatgpt-viewer" role="dialog" aria-modal="true" aria-label="ChatGPT sign-in">
    <div className="chatgpt-viewer-header"><div><strong>Connect ChatGPT</strong><span>Sign in and review permission on OpenAI’s page.</span></div><button className="icon-button" aria-label="Close ChatGPT sign-in" onClick={onClose}><X size={20} /></button></div>
    <p className="chatgpt-viewer-status" role="status">{status}</p>
    <div className="chatgpt-viewer-screen" ref={target} aria-label="Interactive OpenAI sign-in browser" />
  </div>;
}
