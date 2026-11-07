import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, ArrowUpRight, Check, Dumbbell, X } from 'lucide-react';
import { Link } from 'react-router';

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); close.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); };
  }, []);
  return createPortal(<dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} aria-labelledby={titleId}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>
    <div className="modal-feedback" />
    <div className="modal-body">{children}</div>
  </dialog>, document.body);
}

// Native modal dialogs are in the top layer. A body-level toast cannot appear
// above them, regardless of its z-index. Keep feedback in the active dialog.
export function Notification({ message, error, onDismiss }: { message: string; error: boolean; onDismiss: () => void }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const dialogs = [...document.querySelectorAll('dialog[open]')];
      const active = dialogs.at(-1);
      setHost(active?.querySelector('.modal-feedback') ?? active ?? null);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  const content = <div className={`toast ${error ? 'error' : ''} ${host ? 'in-dialog' : ''}`} role={error ? 'alert' : 'status'}>
    {error ? <AlertCircle size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}<span>{message}</span>
    <button type="button" aria-label="Dismiss notification" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div>;
  return host ? createPortal(content, host) : content;
}

export function ProposalReadiness({ ready }: { ready: boolean }) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  if (online && ready) return null;
  return <aside className="proposal-readiness" role="status"><p>{!online ? 'Connect to the internet to accept or reject this proposal.' : 'Finish syncing your training changes and resolve any conflicts before accepting.'}</p>
    <Link className="text-button" to="/settings#sync-settings">Review synchronization</Link>
    <button className="text-button" disabled={!online} onClick={() => window.dispatchEvent(new Event('fitcoach:sync-now'))}>Sync now</button>
  </aside>;
}

export function Empty({ title, text, action, to, onClick }: { title: string; text: string; action?: string; to?: string; onClick?: () => void }) {
  return <div className="empty"><span className="empty-icon"><Dumbbell size={28} /></span><h2>{title}</h2><p>{text}</p>
    {action && (to ? <Link className="button primary" to={to}>{action}<ArrowUpRight size={18} /></Link>
      : <button className="button primary" onClick={onClick}>{action}<ArrowUpRight size={18} /></button>)}</div>;
}

export function SectionTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <div className="section-title"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>;
}

export function Days({ value, onChange }: { value: number[]; onChange: (value: number[]) => void }) {
  return <div className="day-picker">{[1, 2, 3, 4, 5, 6, 0].map(day =>
    <button key={day} type="button" aria-pressed={value.includes(day)} aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]}
      className={value.includes(day) ? 'selected' : ''} onClick={() => onChange(value.includes(day) ? value.filter(d => d !== day) : [...value, day])}>
      {['S', 'M', 'T', 'W', 'T', 'F', 'S'][day]}</button>)}</div>;
}
