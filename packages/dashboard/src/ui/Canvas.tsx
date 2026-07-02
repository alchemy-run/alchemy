import type { UIRegistry } from "alchemy/UI/UIProvider";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
} from "@xyflow/react";
import ELK from "elkjs/lib/elk.bundled.js";
import { useEffect, useMemo, useState } from "react";
import type { DashboardGraph, DashboardMeta } from "../types.ts";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  ResourceNode,
  type CanvasNode,
} from "./ResourceNode.tsx";

const elk = new ELK();

const nodeTypes = { resource: ResourceNode };

interface VisualEdge {
  source: string;
  target: string;
  binding: boolean;
}

/**
 * A binding edge host→resource usually coexists with the reverse dependency
 * edge resource→host (the host consumes the resource's outputs). Rendering
 * both draws a loop around the pair, so merge them: keep the dependency
 * direction, style it as a binding.
 */
function mergeEdges(graph: DashboardGraph): VisualEdge[] {
  const bindings = new Set(
    graph.edges
      .filter((e) => e.kind === "binding")
      .map((e) => `${e.source}->${e.target}`),
  );
  const out: VisualEdge[] = [];
  for (const e of graph.edges) {
    if (
      e.kind === "binding" &&
      graph.edges.some(
        (d) =>
          d.kind === "dependency" &&
          d.source === e.target &&
          d.target === e.source,
      )
    ) {
      continue; // folded into the reverse dependency edge below
    }
    out.push({
      source: e.source,
      target: e.target,
      binding: e.kind === "binding" || bindings.has(`${e.target}->${e.source}`),
    });
  }
  return out;
}

async function layout(
  graph: DashboardGraph,
  edges: VisualEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "36",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.layered.mergeEdges": "true",
    },
    children: graph.nodes.map((n) => ({
      id: n.fqn,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  });
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of res.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
  return positions;
}

export function Canvas({
  graph,
  registry,
  meta,
  selected,
  onSelect,
}: {
  graph: DashboardGraph;
  registry: UIRegistry;
  meta: DashboardMeta;
  selected?: string;
  onSelect: (fqn: string | undefined) => void;
}) {
  const [positions, setPositions] = useState<
    Map<string, { x: number; y: number }>
  >(new Map());

  const visualEdges = useMemo(() => mergeEdges(graph), [graph]);

  useEffect(() => {
    let cancelled = false;
    layout(graph, visualEdges).then((p) => {
      if (!cancelled) {
        setPositions(p);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [graph, visualEdges]);

  const nodes = useMemo<CanvasNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.fqn,
        type: "resource" as const,
        position: positions.get(node.fqn) ?? { x: 0, y: 0 },
        selected: node.fqn === selected,
        data: { node, registry, meta },
      })),
    [graph, positions, registry, meta, selected],
  );

  const edges = useMemo<Edge[]>(
    () =>
      visualEdges.map((edge, i) => ({
        id: `e${i}`,
        source: edge.source,
        target: edge.target,
        animated: edge.binding,
        style: edge.binding
          ? { stroke: "#818cf8", strokeDasharray: "5 4" }
          : { stroke: "#3f3f4a" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: edge.binding ? "#818cf8" : "#3f3f4a",
          width: 16,
          height: 16,
        },
      })),
    [visualEdges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(undefined)}
      colorMode="dark"
      nodesDraggable
      nodesConnectable={false}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color="#26262f"
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
