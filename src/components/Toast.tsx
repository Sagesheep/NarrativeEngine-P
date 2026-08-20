import { create } from 'zustand';
import { useEffect } from 'react';
import { X, AlertTriangle, CheckCircle, Info, AlertCircle } from 'lucide-react';

/* ── Toast types & store ── */

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  expiresAt: number;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastItem[];
  add: (type: ToastType, message: string, action?: ToastAction) => void;
  dismiss: (id: string) => void;
  _prune: () => void;
}

let _seq = 0;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  add(type, message, action) {
    const ttl = type === 'error' ? 8000 : 5000;
    const id = `toast-${++_seq}`;
    const item: ToastItem = { id, type, message, expiresAt: Date.now() + ttl, action };

    set((s) => ({
      toasts: [...s.toasts.slice(-4), item], // keep max 5
    }));

    setTimeout(() => get()._prune(), ttl + 50);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  _prune() {
    const now = Date.now();
    set((s) => ({ toasts: s.toasts.filter((t) => t.expiresAt > now) }));
  },
}));

/** Convenience helpers — importable anywhere, no hooks needed */
export const toast = {
  success: (msg: string, action?: ToastAction) => useToastStore.getState().add('success', msg, action),
  error: (msg: string, action?: ToastAction) => useToastStore.getState().add('error', msg, action),
  warning: (msg: string, action?: ToastAction) => useToastStore.getState().add('warning', msg, action),
  info: (msg: string, action?: ToastAction) => useToastStore.getState().add('info', msg, action),
};

/* ── Icon + color config ── */

const cfg: Record<ToastType, { icon: typeof Info; border: string; bg: string; text: string }> = {
  success: { icon: CheckCircle, border: 'border-green-600', bg: 'bg-green-900/30', text: 'text-green-400' },
  error:   { icon: AlertCircle, border: 'border-danger', bg: 'bg-danger/15', text: 'text-danger' },
  warning: { icon: AlertTriangle, border: 'border-terminal', bg: 'bg-terminal/15', text: 'text-terminal' },
  info:    { icon: Info, border: 'border-ice', bg: 'bg-ice/15', text: 'text-ice' },
};

/* ── Component ── */

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  // Tick every second to prune expired toasts smoothly
  useEffect(() => {
    if (toasts.length === 0) return;
    const iv = setInterval(() => useToastStore.getState()._prune(), 1000);
    return () => clearInterval(iv);
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => {
        const c = cfg[t.type];
        const Icon = c.icon;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 px-3 py-2 border ${c.border} ${c.bg}
                         rounded shadow-lg backdrop-blur-sm max-w-[360px] font-mono text-xs
                         animate-[toast-in_0.25s_ease-out]`}
          >
            <Icon size={14} className={`${c.text} shrink-0 mt-0.5`} />
            <span className="text-text-primary leading-snug break-words">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="shrink-0 ml-1 px-2 py-0.5 border border-terminal/40 text-terminal rounded hover:bg-terminal/10 transition-colors uppercase tracking-wider text-[10px]"
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-text-dim hover:text-text-primary transition-colors ml-auto"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
