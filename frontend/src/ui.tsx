import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Dumbbell, X } from 'lucide-react';
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
    <div className="modal-body">{children}</div>
  </dialog>, document.body);
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
