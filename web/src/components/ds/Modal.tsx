// Modal — accessible dialog rendered in a portal. Provides:
//   • backdrop click + Esc to close
//   • role="dialog" / aria-modal / aria-labelledby
//   • focus trap (Tab/Shift+Tab cycle) and focus restore on close
// Presentation only — callers keep owning open/close state.
import { useEffect, useRef, useId } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { colors, radii, shadow, z } from "../../theme";
import { IconButton } from "./IconButton";

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Modal({ title, subtitle, onClose, children, footer, width = 560 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Focus the first focusable element inside the dialog.
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Tab" && node) {
        const els = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        if (els.length === 0) return;
        const firstEl = els[0]!;
        const lastEl = els[els.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prevFocus?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="ds-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,6,9,0.68)",
        backdropFilter: "blur(5px)",
        WebkitBackdropFilter: "blur(5px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: z.modal,
        padding: 20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className="ds-modal"
        style={{
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.lg,
          boxShadow: shadow.lg,
          width,
          maxWidth: "95vw",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {title && (
          <div
            style={{
              padding: "20px 24px 16px",
              borderBottom: `1px solid ${colors.border}`,
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
              flexShrink: 0,
            }}
          >
            <div>
              <div
                id={titleId}
                style={{ fontSize: 16, fontWeight: 600, color: colors.text, letterSpacing: -0.2 }}
              >
                {title}
              </div>
              {subtitle && (
                <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                  {subtitle}
                </div>
              )}
            </div>
            <IconButton label="Close dialog" icon="✕" onClick={onClose} />
          </div>
        )}
        <div style={{ overflow: "auto", flex: 1 }}>{children}</div>
        {footer && (
          <div
            style={{
              padding: "16px 24px",
              borderTop: `1px solid ${colors.border}`,
              background: "rgba(255,255,255,0.015)",
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              flexShrink: 0,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
