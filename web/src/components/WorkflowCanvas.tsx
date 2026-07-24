// ---------------------------------------------------------------------------
// WorkflowCanvas — the observability graph. React Flow is the RENDERER only;
// the visual identity is ours, not React Flow's.
// ---------------------------------------------------------------------------
// Nodes are operational status cards (StateNode); positions come from ELK
// (useElkLayout). Edges are classified: the primary pipeline is bright + thick,
// conditional branches are muted + dashed, loops are subtle + dashed. Hovering
// a node highlights its connected edges and fades the rest. There's no dotted
// editor grid — just a calm layered surface.
import { useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  Controls,
  type Edge,
  type Node,
  type NodeTypes,
  MarkerType,
} from "reactflow";
import type { WorkflowNodeSummary, InstanceState } from "../api/types";
import { StateNode, type StateNodeData } from "./StateNode";
import { colors, stateColor } from "../theme";
import { STATE_EDGES, isPrimaryState } from "./observe/stateGraph";
import { useElkLayout } from "./observe/useElkLayout";

const nodeTypes: NodeTypes = { stateNode: StateNode };

interface Props {
  nodes: WorkflowNodeSummary[];
  selectedState: string | null;
  onSelectState: (state: string) => void;
  /** Longest-waiting seconds per state (from the inspector's instance list). */
  oldestByState?: Record<string, number | null>;
}

export function WorkflowCanvas({ nodes, selectedState, onSelectState, oldestByState }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  const summaryByState = useMemo(() => {
    const m = new Map<string, WorkflowNodeSummary>();
    for (const n of nodes) m.set(n.state, n);
    return m;
  }, [nodes]);

  const visibleStates = useMemo(
    () => nodes.map((n) => n.state).filter((s): s is InstanceState => !!s),
    [nodes],
  );

  const { positions } = useElkLayout(visibleStates);

  // Busiest active stage → normalises each node's load bar.
  const maxActiveCount = useMemo(() => {
    let max = 0;
    for (const n of nodes) if (!n.terminal && n.count > max) max = n.count;
    return max;
  }, [nodes]);

  // Poll-diff pulse: remember last poll's counts; a node whose count changed
  // this poll pulses once. This is the honest "something moved" signal given a
  // polling (not streaming) API — we don't animate a specific creator's edge.
  const prevCounts = useRef<Record<string, number>>({});
  const [pulsing, setPulsing] = useState<Set<string>>(new Set());
  useEffect(() => {
    const changed = new Set<string>();
    for (const n of nodes) {
      const prev = prevCounts.current[n.state];
      if (prev !== undefined && prev !== n.count) changed.add(n.state);
      prevCounts.current[n.state] = n.count;
    }
    if (changed.size) {
      setPulsing(changed);
      const t = setTimeout(() => setPulsing(new Set()), 1400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [nodes]);

  // Which states are adjacent to the hovered one (for edge/node emphasis).
  const focus = hovered ?? selectedState;
  const adjacent = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const e of STATE_EDGES) {
      if (e.from === focus) set.add(e.to);
      if (e.to === focus) set.add(e.from);
    }
    return set;
  }, [focus]);

  const flowNodes: Node<StateNodeData>[] = useMemo(() => {
    return visibleStates
      .filter((s) => positions[s])
      .map((state) => {
        const summary = summaryByState.get(state)!;
        return {
          id: state,
          type: "stateNode",
          position: positions[state]!,
          draggable: false,
          connectable: false,
          selectable: false,
          data: {
            summary,
            selected: selectedState === state,
            faded: adjacent ? !adjacent.has(state) : false,
            oldestSeconds: oldestByState?.[state] ?? null,
            load: maxActiveCount > 0 && !summary.terminal ? summary.count / maxActiveCount : 0,
            pulse: pulsing.has(state),
            onSelect: onSelectState,
            onHover: setHovered,
          },
        };
      });
  }, [visibleStates, positions, summaryByState, selectedState, adjacent, oldestByState, maxActiveCount, pulsing, onSelectState]);

  const flowEdges: Edge[] = useMemo(() => {
    return STATE_EDGES.filter(
      (e) => summaryByState.has(e.from) && summaryByState.has(e.to) && positions[e.from] && positions[e.to],
    ).map((e) => {
      const onFocusPath = focus ? e.from === focus || e.to === focus : false;
      const dimmed = focus != null && !onFocusPath;
      const primary = e.kind === "primary";
      const dashed = e.kind === "branch" || e.kind === "loop";

      // Colour: focused edges take the destination's state colour; the primary
      // spine is a soft light; branches are muted; everything dims when another
      // node holds focus.
      const baseColor = primary ? colors.borderStrong : colors.hairline;
      const color = onFocusPath ? stateColor[e.to] : baseColor;
      const opacity = dimmed ? 0.25 : 1;

      // Animate only meaningful active paths: the focused edges, and the live
      // primary spine between two populated stages.
      const bothPopulated =
        (summaryByState.get(e.from)?.count ?? 0) > 0 && (summaryByState.get(e.to)?.count ?? 0) > 0;
      const animated = onFocusPath || (primary && bothPopulated && e.from !== e.to);

      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        animated,
        type: "smoothstep",
        pathOptions: { borderRadius: 22 },
        style: {
          stroke: color,
          strokeWidth: onFocusPath ? 2.4 : primary ? 1.8 : 1.2,
          strokeDasharray: dashed ? "5 5" : undefined,
          opacity,
          transition: "stroke 180ms ease, opacity 180ms ease",
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 13,
          height: 13,
        },
      } as Edge;
    });
  }, [summaryByState, positions, focus]);

  return (
    <div style={{ position: "absolute", inset: 0, background: colors.bg }}>
      {/* Very subtle layered radial wash — a calm surface, not an editor grid. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(1200px 700px at 20% -10%, ${colors.panel}80, transparent 60%)`,
          pointerEvents: "none",
        }}
      />
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.35}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnScroll
        zoomOnDoubleClick={false}
        style={{ background: "transparent" }}
      >
        <Controls
          showInteractive={false}
          position="bottom-left"
          className="obs-controls"
        />
      </ReactFlow>
    </div>
  );
}
