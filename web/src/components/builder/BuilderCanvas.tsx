import { useMemo, useCallback } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  MarkerType,
} from "reactflow";
import "reactflow/dist/style.css";
import { Puzzle } from "lucide-react";
import { BuilderNodeComponent } from "./BuilderNode";
import { nodeColor } from "./nodeMeta";
import { colors } from "../../theme";
import { EmptyState } from "../ds";
import type { DraftNode } from "../../api/builderTypes";

const NODE_TYPES = { builderNode: BuilderNodeComponent };

interface Props {
  nodes: DraftNode[];
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  executionCounts?: Record<string, number> | undefined;
  published?: boolean | undefined;
}

const NODE_WIDTH = 300;
const NODE_HEIGHT = 104;
const NODE_GAP = 64;
const COL_X = 120;

export function BuilderCanvas({
  nodes,
  selectedNodeId,
  onSelectNode,
  executionCounts,
  published,
}: Props) {
  const sorted = useMemo(() => [...nodes].sort((a, b) => a.order - b.order), [nodes]);

  // Edges animate only when there's live activity flowing through the workflow.
  const isLive = useMemo(
    () => !!executionCounts && Object.values(executionCounts).some((v) => v > 0),
    [executionCounts],
  );

  const rfNodes: Node[] = useMemo(
    () =>
      sorted.map((n, i) => ({
        id: n.id,
        type: "builderNode",
        position: { x: COL_X, y: i * (NODE_HEIGHT + NODE_GAP) + 24 },
        data: {
          node: n,
          selected: n.id === selectedNodeId,
          executionCount: executionCounts,
          published,
        },
        selectable: true,
        draggable: false,
      })),
    [sorted, selectedNodeId, executionCounts, published],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      sorted.slice(0, -1).map((n, i) => {
        const next = sorted[i + 1];
        return {
          id: `e-${n.id}-${next?.id ?? "end"}`,
          source: n.id,
          target: next?.id ?? "",
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, color: colors.borderStrong, width: 16, height: 16 },
          style: { stroke: colors.borderStrong, strokeWidth: 2 },
          animated: isLive,
        };
      }),
    [sorted, isLive],
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
      <EmptyState
        icon={<Puzzle size={24} strokeWidth={1.75} color={colors.textMuted} />}
        title="No nodes in this workflow"
        description="This workflow has no steps yet. Nodes come from the template you chose when creating the workflow."
      />
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
      fitViewOptions={{ padding: 0.35 }}
      minZoom={0.3}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={true}
      panOnDrag={true}
      zoomOnScroll={true}
      style={{ background: colors.bg }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} color={colors.border} gap={22} size={1.5} />
      <Controls
        showInteractive={false}
        style={{
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
          overflow: "hidden",
        }}
      />
      <MiniMap
        pannable
        zoomable
        ariaLabel="Workflow minimap"
        style={{
          background: colors.panel,
          border: `1px solid ${colors.border}`,
          borderRadius: 8,
        }}
        maskColor="rgba(13,17,23,0.65)"
        nodeColor={(n) => {
          const data = n.data as { node?: DraftNode } | undefined;
          return data?.node ? nodeColor(data.node.type) : colors.border;
        }}
        nodeStrokeWidth={0}
        nodeBorderRadius={4}
      />
    </ReactFlow>
  );
}
