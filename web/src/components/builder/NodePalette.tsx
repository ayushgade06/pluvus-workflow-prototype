// ---------------------------------------------------------------------------
// NodePalette (Phase 17) — draggable source of new nodes for the graph editor.
// ---------------------------------------------------------------------------
// Each item is HTML5-draggable. On dragstart it stashes the node type in the
// dataTransfer payload; GraphCanvas reads it in onDrop and materializes a node
// at the drop position. Clicking an item is an accessible fallback that appends
// a node (handled by the parent via onAdd).
// ---------------------------------------------------------------------------

import { GripVertical } from "lucide-react";
import { colors, radii, font, shadow } from "../../theme";
import { SectionHeader, Tooltip } from "../ds";
import { paletteItems } from "../../workflow/nodeDefaults";
import { nodeIconComponent } from "./nodeMeta";
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
        {items.map((item) => {
          const Icon = nodeIconComponent(item.type);
          return (
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
                  background: colors.panel,
                  border: `2px solid ${colors.cardBorder}`,
                  borderRadius: radii.md,
                  boxShadow: shadow.sm,
                  cursor: "grab",
                  userSelect: "none",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    background: `${item.color}2e`,
                    border: `1.5px solid ${colors.cardBorder}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: colors.text,
                    flexShrink: 0,
                  }}
                >
                  <Icon size={16} strokeWidth={2.25} />
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: font.size.md,
                    fontWeight: font.weight.semibold,
                    color: colors.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.label}
                </span>
                <GripVertical size={14} aria-hidden style={{ color: colors.textDim, flexShrink: 0, opacity: 0.7 }} />
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
