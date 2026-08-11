import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from './Icons';
import './Toast.css';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. `0` keeps it until dismissed. */
  duration?: number;
  /** A single inline action, e.g. "Undo". */
  action?: { label: string; onClick: () => void };
}

export interface ToastRecord extends Required<Pick<ToastOptions, 'tone' | 'duration'>> {
  id: number;
  message: ReactNode;
  action?: ToastOptions['action'];
}

interface ToastContextValue {
  toast: (message: ReactNode, options?: ToastOptions) => number;
  success: (message: ReactNode, options?: Omit<ToastOptions, 'tone'>) => number;
  error: (message: ReactNode, options?: Omit<ToastOptions, 'tone'>) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 5_000;
/** Errors stay long enough to be read at 3am. */
const ERROR_DURATION = 9_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const toast = useCallback((message: ReactNode, options: ToastOptions = {}) => {
    const tone = options.tone ?? 'info';
    const id = nextId.current++;
    setToasts((current) => [
      // Three at a time is plenty; older ones fall off the top.
      ...current.slice(-2),
      {
        id,
        message,
        tone,
        duration: options.duration ?? (tone === 'error' ? ERROR_DURATION : DEFAULT_DURATION),
        action: options.action,
      },
    ]);
    return id;
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      success: (message, options) => toast(message, { ...options, tone: 'success' }),
      error: (message, options) => toast(message, { ...options, tone: 'error' }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: number) => void;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="toast-region">
      {/*
        Two regions, because politeness is per-region: a failure interrupts,
        a confirmation waits its turn.
      */}
      <ol className="toast-list" aria-live="polite" aria-relevant="additions">
        {toasts
          .filter((entry) => entry.tone !== 'error')
          .map((entry) => (
            <ToastItem key={entry.id} toast={entry} onDismiss={onDismiss} />
          ))}
      </ol>
      <ol className="toast-list" role="alert" aria-live="assertive">
        {toasts
          .filter((entry) => entry.tone === 'error')
          .map((entry) => (
            <ToastItem key={entry.id} toast={entry} onDismiss={onDismiss} />
          ))}
      </ol>
    </div>,
    document.body,
  );
}

const TONE_ICON = {
  info: InfoIcon,
  success: CheckIcon,
  error: AlertIcon,
} as const;

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastRecord;
  onDismiss: (id: number) => void;
}) {
  const { id, duration } = toast;
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (duration <= 0 || paused) return;
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, paused, onDismiss]);

  const ToneIcon = TONE_ICON[toast.tone];

  return (
    <li
      className={`toast toast--${toast.tone}`}
      // Hovering or focusing inside pauses the timer, so a toast with an
      // "Undo" cannot disappear from under the pointer heading for it.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__icon">
        <ToneIcon size={18} />
      </span>
      <span className="toast__message">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          className="toast__action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(id);
          }}
        >
          {toast.action.label}
        </button>
      ) : null}
      <IconButton
        label="Dismiss"
        icon={<CloseIcon size={16} />}
        size="sm"
        onClick={() => onDismiss(id)}
      />
    </li>
  );
}
