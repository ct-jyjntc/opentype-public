import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight, AudioLines, BookOpen, Check, CircleAlert, CircleHelp, Clock, Cloud, Copy, Download,
  History, Hourglass, House, Info, Languages, Lock, MessageCircleQuestion, Mic, PenLine, Plus,
  RefreshCw, Search, Settings, Sparkles, TextCursorInput, Trash2, User, X, Zap, Upload, Ellipsis,
  WandSparkles, Blocks, AlignLeft, Scissors, Replace, SpellCheck, ShieldCheck, type LucideIcon,
} from 'lucide-react'
// Icons come from Lucide (https://lucide.dev) so every glyph shares one grid and stroke.
// Callers keep using short semantic names; unknown names fall back to the sparkle.
const icons: Record<string, LucideIcon> = {
  home: House,
  history: History,
  book: BookOpen,
  settings: Settings,
  mic: Mic,
  user: User,
  clock: Clock,
  bolt: Zap,
  hourglass: Hourglass,
  pen: PenLine,
  lock: Lock,
  logo: AudioLines,
  close: X,
  plus: Plus,
  search: Search,
  copy: Copy,
  trash: Trash2,
  arrow: ArrowRight,
  check: Check,
  cloud: Cloud,
  spark: Sparkles,
  info: Info,
  help: CircleHelp,
  download: Download,
  upload: Upload,
  more: Ellipsis,
  wand: WandSparkles,
  blocks: Blocks,
  list: AlignLeft,
  scissors: Scissors,
  replace: Replace,
  spellcheck: SpellCheck,
  languages: Languages,
  shield: ShieldCheck,
  refresh: RefreshCw,
  trans: Languages,
  ask: MessageCircleQuestion,
  error: CircleAlert,
  injecting: TextCursorInput,
}

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const Glyph = icons[name] ?? Sparkles
  return <Glyph size={size} strokeWidth={name === 'logo' ? 2.25 : 1.75} aria-hidden="true" />
}

export function IconButton({
  name,
  label,
  onClick,
  disabled,
}: {
  name: string
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      className="icon-button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={name} />
    </button>
  )
}
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}
export function Row({
  title,
  description,
  children,
  tone,
}: {
  title: string
  description?: string
  children: ReactNode
  tone?: 'warn' | 'ok'
}) {
  return (
    <div className={`setting-row${tone ? ' tone-' + tone : ''}`}>
      <div>
        <strong>{tone && <Icon name={tone === 'warn' ? 'error' : 'check'} size={15} />}{title}</strong>
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    const el = ref.current!
    const items = () =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"]',
        ),
      )
    ;(items()[0] ?? el).focus()
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
      if (e.key === 'Tab') {
        e.stopPropagation()
        const list = items()
        const first = list[0],
          last = list.at(-1)
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    el.addEventListener('keydown', handler)
    return () => {
      el.removeEventListener('keydown', handler)
      previous?.focus()
    }
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <IconButton name="close" label="关闭" onClick={onClose} />
        </header>
        {children}
      </div>
    </div>
  )
}
export function Empty({
  icon,
  title,
  description,
}: {
  icon: string
  title: string
  description: string
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={32} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

export interface MenuItem { label: string; aria?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
// A small overflow menu: one round "⋯" button that opens a list of secondary actions.
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !root.current?.contains(document.activeElement)) return
      // Consume Escape before an enclosing modal's native keydown listener.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])
  return (
    <div className="menu" ref={root} onBlur={e => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false)
    }}>
      <button ref={trigger} type="button" className="menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map(item => (
            <button type="button" role="menuitem" key={item.label} aria-label={item.aria} className={item.danger ? 'danger-text' : ''} disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect() }}>{item.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
