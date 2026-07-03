// ---------------------------------------------------------------------------
// Workflow graph model (Phase 17) — the editor's source of truth.
// ---------------------------------------------------------------------------
// The builder edits a GRAPH (nodes + edges + positions). The execution runtime,
// however, still consumes the legacy flat `NodeSnapshot[]` ordered by `order`
// (see server/src/engine/runtime.ts, which sorts by n.order). To keep the
// runtime 100% untouched we treat the graph as an *editing/validation* layer and
// serialize it DOWN to the linear ordered array on save.
//
//   draftNodes[] (persisted, runtime reads this) <──> WorkflowDefinition (editor)
//        graphToLinearNodes()                          linearNodesToGraph()
//
// The extra graph data (edges + positions) rides along in an ADDITIVE, runtime-
// ignored field on each node's config (`_graph`), so nothing about the on-wire
// NodeSnapshot shape the engine sees changes. Old drafts with no `_graph` are
// migrated on the fly by linearNodesToGraph() (implicit edges from `order`).
//
// This file is pure data/logic — no React, no react-flow imports. It is safe to
// unit test in isolation.
// ---------------------------------------------------------------------------

import type { DraftNode, NodeType, NodeConfig } from "../api/builderTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface XYPosition {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  position: XYPosition;
  config: NodeConfig;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowMetadata {
  /** Bumped whenever the graph shape changes; lets us evolve the format later. */
  schemaVersion: number;
}

export interface WorkflowDefinition {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: WorkflowMetadata;
}

export const GRAPH_SCHEMA_VERSION = 1;

// Persisted-but-runtime-ignored graph metadata that we stash on each node's
// config so a round-trip through the flat array preserves positions + edges.
interface GraphConfigSidecar {
  position?: XYPosition;
  /** Ids of nodes this node points to (outgoing edges). */
  next?: string[];
}

const SIDECAR_KEY = "_graph";

// ---------------------------------------------------------------------------
// Layout constants — the default vertical stack used when auto-laying-out a
// migrated linear workflow (mirrors the old BuilderCanvas geometry).
// ---------------------------------------------------------------------------

export const NODE_WIDTH = 300;
export const NODE_HEIGHT = 104;
const NODE_GAP = 64;
const COL_X = 160;
const TOP_Y = 24;

export function defaultPositionForIndex(index: number): XYPosition {
  return { x: COL_X, y: index * (NODE_HEIGHT + NODE_GAP) + TOP_Y };
}

// ---------------------------------------------------------------------------
// Edge id helper — deterministic so the same connection always has the same id
// (dedupe + validation rely on this).
// ---------------------------------------------------------------------------

export function edgeId(source: string, target: string): string {
  return `e:${source}->${target}`;
}

// ---------------------------------------------------------------------------
// linearNodesToGraph — migrate a persisted draftNodes[] into a graph.
// ---------------------------------------------------------------------------
// If a node carries a `_graph` sidecar (saved by a previous graph-edit), we use
// its stored position + explicit `next` edges. Otherwise we fall back to the
// legacy behaviour: auto-layout by `order` and chain each node to the next
// (implicit linear edges). This is the backward-compat migration helper — any
// workflow created before the graph builder opens seamlessly.
export function linearNodesToGraph(draftNodes: DraftNode[]): WorkflowDefinition {
  const sorted = [...draftNodes].sort((a, b) => a.order - b.order);

  const nodes: GraphNode[] = sorted.map((n, i) => {
    const { config, sidecar } = splitSidecar(n.config);
    return {
      id: n.id,
      type: n.type,
      position: sidecar.position ?? defaultPositionForIndex(i),
      config,
    };
  });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const hasStoredEdges = sorted.some((n) => {
    const { sidecar } = splitSidecar(n.config);
    return Array.isArray(sidecar.next);
  });

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  if (hasStoredEdges) {
    // Explicit edges saved by a previous graph edit.
    for (const n of sorted) {
      const { sidecar } = splitSidecar(n.config);
      for (const target of sidecar.next ?? []) {
        if (!nodeIds.has(target)) continue; // drop dangling refs defensively
        const id = edgeId(n.id, target);
        if (seen.has(id)) continue;
        seen.add(id);
        edges.push({ id, source: n.id, target });
      }
    }
  } else {
    // Legacy linear workflow — chain by order.
    for (let i = 0; i < sorted.length - 1; i++) {
      const source = sorted[i]!;
      const target = sorted[i + 1]!;
      const id = edgeId(source.id, target.id);
      seen.add(id);
      edges.push({ id, source: source.id, target: target.id });
    }
  }

  return {
    nodes,
    edges,
    metadata: { schemaVersion: GRAPH_SCHEMA_VERSION },
  };
}

// ---------------------------------------------------------------------------
// graphToLinearNodes — serialize a graph back to the runtime's ordered array.
// ---------------------------------------------------------------------------
// A valid linear workflow has a single path start → … → terminal. We compute
// `order` by a topological walk from the start node following the single
// outgoing edge chain. Nodes not on the path (or graphs with branches/cycles
// that make a clean linear order impossible) fall back to a stable order so we
// never lose data on save — validation is what BLOCKS publish/launch, not this
// serializer. Each node's edges + position are stashed in the `_graph` sidecar
// so the next load reconstructs the exact graph.
export function graphToLinearNodes(def: WorkflowDefinition): DraftNode[] {
  const order = topologicalOrder(def);

  return order.map((node, i) => {
    const outgoing = def.edges.filter((e) => e.source === node.id).map((e) => e.target);
    const sidecar: GraphConfigSidecar = {
      position: node.position,
      next: outgoing,
    };
    return {
      id: node.id,
      type: node.type,
      order: i,
      config: {
        ...(node.config as Record<string, unknown>),
        [SIDECAR_KEY]: sidecar,
      } as NodeConfig,
    };
  });
}

// ---------------------------------------------------------------------------
// topologicalOrder — best-effort linear ordering of the graph nodes.
// ---------------------------------------------------------------------------
// Follows the chain from the unique start node (a node with no incoming edge).
// Falls back to appending any not-yet-visited nodes (branches, islands, cycle
// members) in their existing array order so no node is ever dropped.
export function topologicalOrder(def: WorkflowDefinition): GraphNode[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const outMap = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of def.nodes) {
    outMap.set(n.id, []);
    indeg.set(n.id, 0);
  }
  for (const e of def.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    outMap.get(e.source)!.push(e.target);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  const result: GraphNode[] = [];
  const visited = new Set<string>();

  // Start from nodes with no incoming edge (in the linear case there's exactly
  // one). Walk the chain greedily.
  const starts = def.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0);
  const queue = [...starts];
  while (queue.length) {
    const n = queue.shift()!;
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    result.push(n);
    for (const targetId of outMap.get(n.id) ?? []) {
      const target = byId.get(targetId);
      if (target && !visited.has(targetId)) queue.push(target);
    }
  }

  // Append anything unreachable/cyclic in original order so nothing is lost.
  for (const n of def.nodes) {
    if (!visited.has(n.id)) result.push(n);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sidecar helpers — split/strip the runtime-ignored `_graph` field.
// ---------------------------------------------------------------------------

function splitSidecar(config: NodeConfig): { config: NodeConfig; sidecar: GraphConfigSidecar } {
  const raw = config as Record<string, unknown>;
  const sidecarRaw = raw[SIDECAR_KEY];
  const sidecar: GraphConfigSidecar =
    sidecarRaw && typeof sidecarRaw === "object" ? (sidecarRaw as GraphConfigSidecar) : {};
  // Return config WITHOUT the sidecar so editor forms never see it.
  const clean: Record<string, unknown> = { ...raw };
  delete clean[SIDECAR_KEY];
  return { config: clean as NodeConfig, sidecar };
}

/** Strip the `_graph` sidecar from a config (for callers that only want the
 * user-facing config, e.g. the config panel). */
export function stripGraphSidecar(config: NodeConfig): NodeConfig {
  return splitSidecar(config).config;
}
