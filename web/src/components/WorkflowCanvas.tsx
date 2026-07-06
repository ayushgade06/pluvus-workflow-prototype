// ---------------------------------------------------------------------------
// WorkflowCanvas — the primary React Flow experience (Part 1 + 2).
// ---------------------------------------------------------------------------
// The workflow IS the navigation model: a vertical "happy path" pipeline down
// the centre, with terminal/branch states fanned to the right. Nodes carry live
// counts and update on the polling interval without a page refresh.

import { useMemo } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  type Node,
  type NodeTypes,
  MarkerType,
} from "reactflow";
import type { WorkflowNodeSummary, InstanceState } from "../api/types";
import { StateNode, type StateNodeData } from "./StateNode";
import { colors, stateColor } from "../theme";

const nodeTypes: NodeTypes = { stateNode: StateNode };

// Fixed layout coordinates. Main pipeline runs down x=COL_MAIN; branch/terminal
// states sit to the right at x=COL_BRANCH, aligned to the row they branch from.
const COL_MAIN = 60;
const COL_BRANCH = 360;
const COL_TERMINAL = 660;
const ROW_H = 150;

interface Placement {
  x: number;
  y: number;
}

// Hand-placed so the diagram reads like the engine's actual transition graph.
const LAYOUT: Record<InstanceState, Placement> = {
  ENROLLED: { x: COL_MAIN, y: 0 },
  OUTREACH_SENT: { x: COL_MAIN, y: ROW_H },
  AWAITING_REPLY: { x: COL_MAIN, y: ROW_H * 2 },
  FOLLOWED_UP: { x: COL_BRANCH, y: ROW_H * 2 },
  REPLY_RECEIVED: { x: COL_MAIN, y: ROW_H * 3 },
  NEGOTIATING: { x: COL_MAIN, y: ROW_H * 4 },
  ACCEPTED: { x: COL_MAIN, y: ROW_H * 5 },
  // Reward Setup runs down the main column after ACCEPTED.
  REWARD_PENDING: { x: COL_MAIN, y: ROW_H * 6 },
  REWARD_CONFIRMED: { x: COL_MAIN, y: ROW_H * 7 },
  // Payment Info continues down the main column after Reward Setup.
  PAYMENT_PENDING: { x: COL_MAIN, y: ROW_H * 8 },
  PAYMENT_RECEIVED: { x: COL_MAIN, y: ROW_H * 9 },
  // Content Brief continues down the main column after Payment Info (terminal).
  CONTENT_BRIEF_SENT: { x: COL_MAIN, y: ROW_H * 10 },
  // Branch / terminal states to the right.
  REJECTED: { x: COL_BRANCH, y: ROW_H * 3 },
  MANUAL_REVIEW: { x: COL_TERMINAL, y: ROW_H * 3.5 },
  OPTED_OUT: { x: COL_BRANCH, y: ROW_H * 5 },
  NO_RESPONSE: { x: COL_TERMINAL, y: ROW_H * 2 },
};

// Edges mirror stateMachine.ts transitions (the meaningful ones for the demo).
const EDGES: Array<[InstanceState, InstanceState, boolean?]> = [
  ["ENROLLED", "OUTREACH_SENT"],
  ["OUTREACH_SENT", "AWAITING_REPLY"],
  ["AWAITING_REPLY", "FOLLOWED_UP"],
  ["FOLLOWED_UP", "AWAITING_REPLY", true], // loop back
  ["AWAITING_REPLY", "REPLY_RECEIVED"],
  ["AWAITING_REPLY", "NO_RESPONSE"],
  ["REPLY_RECEIVED", "NEGOTIATING"],
  ["REPLY_RECEIVED", "REJECTED"],
  ["REPLY_RECEIVED", "MANUAL_REVIEW"],
  ["NEGOTIATING", "NEGOTIATING", true], // self-loop (counter rounds)
  ["NEGOTIATING", "ACCEPTED"],
  ["NEGOTIATING", "REJECTED"],
  ["NEGOTIATING", "MANUAL_REVIEW"],
  ["ACCEPTED", "PAYMENT_PENDING"], // merged flow: auto-chain into Content Brief (sends offer + payout link + brief)
  ["PAYMENT_PENDING", "CONTENT_BRIEF_SENT"], // merged flow: creator submits payout form → terminal
  ["ACCEPTED", "REWARD_PENDING"], // legacy: auto-chain into Reward Setup
  ["REWARD_PENDING", "REWARD_PENDING", true], // self-loop (non-confirming reply)
  ["REWARD_PENDING", "REWARD_CONFIRMED"], // creator confirms
  ["REWARD_PENDING", "MANUAL_REVIEW"],
  ["REWARD_CONFIRMED", "PAYMENT_PENDING"], // legacy: auto-chain into Payment Info
  ["PAYMENT_PENDING", "PAYMENT_RECEIVED"], // legacy: creator submits the payout form
  ["PAYMENT_PENDING", "MANUAL_REVIEW"],
  ["PAYMENT_RECEIVED", "CONTENT_BRIEF_SENT"], // legacy: auto-chain into Content Brief
];

interface Props {
  nodes: WorkflowNodeSummary[];
  selectedState: string | null;
  onSelectState: (state: string) => void;
}

export function WorkflowCanvas({ nodes, selectedState, onSelectState }: Props) {
  const summaryByState = useMemo(() => {
    const m = new Map<string, WorkflowNodeSummary>();
    for (const n of nodes) m.set(n.state, n);
    return m;
  }, [nodes]);

  const flowNodes: Node<StateNodeData>[] = useMemo(() => {
    return (Object.keys(LAYOUT) as InstanceState[])
      .filter((s) => summaryByState.has(s))
      .map((state) => {
        const summary = summaryByState.get(state)!;
        return {
          id: state,
          type: "stateNode",
          position: LAYOUT[state],
          draggable: false,
          connectable: false,
          data: {
            summary,
            selected: selectedState === state,
            onSelect: onSelectState,
          },
        };
      });
  }, [summaryByState, selectedState, onSelectState]);

  const flowEdges: Edge[] = useMemo(() => {
    return EDGES.filter(
      ([from, to]) => summaryByState.has(from) && summaryByState.has(to),
    ).map(([from, to, loop]) => {
      // Highlight an edge when either endpoint is the selected node.
      const active = selectedState === from || selectedState === to;
      const color = active ? stateColor[to] : colors.borderStrong;
      return {
        id: `${from}->${to}`,
        source: from,
        target: to,
        animated: active,
        style: { stroke: color, strokeWidth: active ? 2 : 1.5, strokeDasharray: loop ? "4 3" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        type: "smoothstep",
      };
    });
  }, [summaryByState, selectedState]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.4}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll
      style={{ background: colors.bg }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#22242c" />
      <Controls
        showInteractive={false}
        position="bottom-left"
        style={{
          background: colors.panel,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 2px 6px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.28)",
        }}
      />
    </ReactFlow>
  );
}
