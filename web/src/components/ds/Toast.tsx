// Toast — non-blocking notifications. Mount <ToastProvider> once at the app
// root; call useToast() anywhere to push success/error/info messages.
// This is purely additive: existing inline error/success banners can stay or
// be replaced incrementally — toasts don't alter any control flow.
import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { colors, radii, shadow, font, z } from "../../theme";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: ReactNode;
}

interface ToastApi {
  success: (message: ReactNode) => void;
  error: (message: ReactNode) => void;
  info: (message: ReactNode) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_META: Record<ToastKind, { color: string; icon: string }> = {
  success: { color: colors.success, icon: "✓" },
  error: { color: colors.danger, icon: "✕" },
  info: { color: colors.accent, icon: "ℹ" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: ReactNode) => {
      const id = ++seq.current;
      setItems((prev) => [...prev, { id, kind, message }]);
      window.setTimeout(() => dismiss(id), 4200);
    },
    [dismiss],
  );

  const api = useRef<ToastApi>({
    success: (m) => push("success", m),
    error: (m) => push("error", m),
    info: (m) => push("info", m),
  });
  // Keep the closure fresh (push is stable via useCallback deps).
  api.current = {
    success: (m) => push("success", m),
    error: (m) => push("error", m),
    info: (m) => push("info", m),
  };

  return (
    <ToastContext.Provider value={api.current}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          role="status"
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            zIndex: z.toast,
            maxWidth: "calc(100vw - 40px)",
          }}
        >
          {items.map((t) => {
            const meta = KIND_META[t.kind];
            return (
              <div
                key={t.id}
                className="ds-toast"
                onClick={() => dismiss(t.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 240,
                  maxWidth: 380,
                  padding: "10px 14px",
                  background: colors.panel,
                  border: `1px solid ${colors.border}`,
                  borderLeft: `3px solid ${meta.color}`,
                  borderRadius: radii.md,
                  boxShadow: shadow.md,
                  cursor: "pointer",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: `${meta.color}22`,
                    color: meta.color,
                    fontSize: 11,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {meta.icon}
                </span>
                <span style={{ fontSize: font.size.md, color: colors.text, lineHeight: 1.4 }}>
                  {t.message}
                </span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

/**
 * Access the toast API. Safe to call even if no provider is mounted yet — in
 * that case it no-ops, so partial adoption never throws.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  return ctx ?? NOOP;
}

const NOOP: ToastApi = { success: () => {}, error: () => {}, info: () => {} };
