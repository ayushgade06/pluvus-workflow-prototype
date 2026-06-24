import { useMemo, useCallback } from "react";
import ReactFlow, {
  Background,
  Controls,
  type Node,
  type Edge,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import { BuilderNodeComponent } from "./BuilderNode";
import { colors } from "../../theme";
import type { DraftNode } from "../../api/builderTypes";

const NODE_TYPES = { builderNode: BuilderNodeComponent };

interface Props {
  nodes: DraftNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  executionCounts?: Record<string, number> | undefined;
}

const NODE_WIDTH = 280;
const NODE_HEIGHT = 90;
const NODE_GAP = 50;
const COL_X = 100;

export function BuilderCanvas({
  nodes,
  selectedNodeId,
  onSelectNode,
  executionCounts,
}: Props) {
  const sorted = useMemo(
    () => [...nodes].sort((a, b) => a.order - b.order),
    [nodes],
  );

  const rfNodes: Node[] = useMemo(
    () =>
      sorted.map((n, i) => ({
        id: n.id,
        type: "builderNode",
        position: { x: COL_X, y: i * (NODE_HEIGHT + NODE_GAP) + 20 },
        data: {
          node: n,
          selected: n.id === selectedNodeId,
          executionCount: executionCounts,
        },
        selectable: true,
        draggable: false,
      })),
    [sorted, selectedNodeId, executionCounts],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      sorted.slice(0, -1).map((n, i) => ({
        id: `e-${n.id}-${sorted[i + 1]?.id ?? "end"}`,
        source: n.id,
        target: sorted[i + 1]?.id ?? "",
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, color: colors.border },
        style: { stroke: colors.border, strokeWidth: 1.5 },
        animated: false,
      })),
    [sorted],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onSelectNode(node.id === selectedNodeId ? null : node.id);
    },
    [onSelectNode, selectedNodeId],
  );

  const onPaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  if (nodes.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: colors.textMuted,
          fontSize: 13,
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 32 }}>📋</div>
        <div>No nodes in this workflow. Add nodes to start building.</div>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={NODE_TYPES}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={true}
      panOnDrag={true}
      zoomOnScroll={true}
      style={{ background: colors.bg }}
      proOptions={{ hideAttribution: true }}
    >
      <Background color={colors.border} gap={24} />
      <Controls
        style={{
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
        }}
      />
    </ReactFlow>
  );
}
