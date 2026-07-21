// HoverCard — rich hover/focus popover rendered in a portal.
//
// Why this exists alongside Tooltip: `.ds-tooltip` is absolutely positioned
// inside its trigger's stacking context, so any ancestor with `overflow: auto`
// clips it — which is exactly the situation inside a scrolling data table. This
// renders to document.body with `position: fixed` computed from the trigger's
// bounding rect, so nothing can clip it, and it can hold real markup rather
// than a single line of text.
//
// Opens on hover AND focus, closes on blur/leave/Escape/scroll. The trigger is
// rendered as a button so it is keyboard reachable.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { colors, radii, z } from "../../theme";

interface Props {
  content: ReactNode;
  children: ReactNode;
  /** Accessible name for the trigger button. */
  label: string;
  maxWidth?: number;
}

interface Pos {
  left: number;
  top: number;
  placement: "above" | "below";
}

const GAP = 8;
const MARGIN = 8;

export function HoverCard({ content, children, label, maxWidth = 320 }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cardH = cardRef.current?.offsetHeight ?? 0;
    const cardW = cardRef.current?.offsetWidth ?? maxWidth;

    // Prefer above; flip below when there is not room, so the card never sits
    // off-screen on the first rows of a table.
    const roomAbove = r.top;
    const placement: Pos["placement"] =
      cardH > 0 && roomAbove < cardH + GAP ? "below" : "above";

    // Centre on the trigger, then clamp into the viewport.
    let left = r.left + r.width / 2 - cardW / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - cardW - MARGIN));

    const top = placement === "above" ? r.top - GAP - cardH : r.bottom + GAP;
    setPos({ left, top, placement });
  }, [maxWidth]);

  const open = useCallback(() => {
    // Mount at a provisional position, then measure and correct on the next
    // frame — height is unknown until the content is in the DOM.
    setPos({ left: -9999, top: -9999, placement: "above" });
  }, []);

  const close = useCallback(() => setPos(null), []);

  const isOpen = pos !== null;

  useEffect(() => {
    if (!isOpen) return;
    place();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // A fixed-position card would visually detach from its trigger once
    // anything scrolls, so dismiss instead of chasing it.
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
    // `place` reads the freshly-mounted card, so this must run after mount.
  }, [isOpen, place, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={isOpen}
        className="ds-focusable"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={(e) => {
          // Do not let a click bubble into a row label and toggle selection.
          e.preventDefault();
          e.stopPropagation();
        }}
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          font: "inherit",
          color: "inherit",
          cursor: "default",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        {children}
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={cardRef}
            role="tooltip"
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              zIndex: z.tooltip,
              maxWidth,
              background: colors.panelAlt,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              boxShadow: "0 10px 28px rgba(0,0,0,0.5)",
              padding: "9px 11px",
              pointerEvents: "none",
              // Hidden until measured, so it never flashes at -9999.
              visibility: pos.left < 0 ? "hidden" : "visible",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
