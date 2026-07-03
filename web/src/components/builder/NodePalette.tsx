// ---------------------------------------------------------------------------
// NodePalette (Phase 17) — draggable source of new nodes for the graph editor.
// ---------------------------------------------------------------------------
// Each item is HTML5-draggable. On dragstart it stashes the node type in the
// dataTransfer payload; GraphCanvas reads it in onDrop and materializes a node
// at the drop position. Clicking an item is an accessible fallback that appends
// a node (handled by the parent via onAdd).
// ---------------------------------------------------------------------------

import { colors, radii, font } from "../../theme";
import { SectionHeader, Tooltip } from "../ds";
import { paletteItems } from "../../workflow/nodeDefaults";
import type { NodeType } from "../../api/builderTypes";

export const PALETTE_DND_MIME = "application/x-pluvus-node-type";

interface Props {
  onAdd: (type: NodeType) => void;
}

export function NodePalette({ onAdd }: Props) {
  const items = paletteItems();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: "16px 16px 8px" }}>
        <SectionHeader>Add nodes</SectionHeader>
        <div style={{ fontSize: font.size.xs, color: colors.textDim, lineHeight: 1.55, marginTop: 2 }}>
          Drag onto the canvas, or click to append.
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "8px 14px 18px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {items.map((item) => (
          <Tooltip key={item.type} content={item.description}>
            <div
              role="button"
              tabIndex={0}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(PALETTE_DND_MIME, item.type);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd(item.type)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onAdd(item.type);
                }
              }}
              className="ds-focusable ds-card-interactive"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                background: colors.panelAlt,
                border: `1px solid ${colors.border}`,
                borderRadius: radii.md,
                cursor: "grab",
                userSelect: "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: `${item.color}1c`,
                  border: `1px solid ${item.color}26`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 14,
                  flexShrink: 0,
                }}
              >
                {item.icon}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: font.size.md,
                  fontWeight: font.weight.medium,
                  color: colors.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </span>
              <span aria-hidden style={{ color: colors.textDim, fontSize: 13, flexShrink: 0, opacity: 0.7 }}>
                ⠿
              </span>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
