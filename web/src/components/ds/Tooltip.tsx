// Tooltip — CSS-driven hover/focus tooltip (see .ds-tooltip in index.css).
// Wraps any trigger; the tooltip is focus-reachable (focus-within) for a11y.
import type { ReactNode } from "react";

interface Props {
  content: ReactNode;
  children: ReactNode;
  /** When false, renders children without a tooltip wrapper. */
  enabled?: boolean;
}

export function Tooltip({ content, children, enabled = true }: Props) {
  if (!enabled || content == null || content === "") return <>{children}</>;
  return (
    <span className="ds-tooltip-wrap">
      {children}
      <span role="tooltip" className="ds-tooltip">
        {content}
      </span>
    </span>
  );
}
