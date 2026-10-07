import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

export interface ToastOptions {
  message: string;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before the toast disappears (default 8 s). */
  durationMs?: number;
}

interface Toast extends ToastOptions {
  id: number;
}

const ToastContext = createContext<((toast: ToastOptions) => void) | null>(null);

/** Shows short notifications (e.g. "Deleted · Undo"). CSP-safe: no injected styles. */
export function useToast(): (toast: ToastOptions) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error('ToastProvider is missing');
  return show;
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const { t } = useTranslation();
  const { id, durationMs } = toast;
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose(id);
    }, durationMs ?? 8000);
    return () => {
      clearTimeout(timer);
    };
  }, [id, durationMs, onClose]);
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg">
      <span className="flex-1">{toast.message}</span>
      {toast.action && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            toast.action?.onClick();
            onClose(id);
          }}
        >
          {toast.action.label}
        </Button>
      )}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t('common.close')}
        onClick={() => {
          onClose(id);
        }}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const show = useCallback((toast: ToastOptions) => {
    const id = nextId.current++;
    setToasts((list) => [...list.slice(-2), { ...toast, id }]);
  }, []);
  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 mx-auto flex max-w-md flex-col gap-2 px-4 lg:bottom-4"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
