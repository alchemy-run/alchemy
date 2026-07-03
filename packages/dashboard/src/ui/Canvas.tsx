/**
 * The graph canvas (v2 data flow — takes NO props, reads the store).
 *
 * Render doctrine:
 * - React Flow node objects carry `data: { fqn }` ONLY (stable per-fqn
 *   object), are rebuilt only when the structural hash or its positions
 *   change, and unchanged nodes keep identity so memoized ResourceNodes
 *   skip. Decorate patches therefore re-render exactly the affected node.
 * - Edges are memoized per structural hash with hoisted style/marker
 *   constants and stable `edgeKeyOf` ids.
 * - ELK runs in a Web Worker keyed by structuralHash (useCanvasLayout);
 *   positions live in the store's LRU and survive view/stage switches.
 * - fitView fires only on the first-ever layout of a never-seen hash (and
 *   never once the user has panned), or when the explicit Fit button bumps
 *   `layout.fitRequest`.
 * - The viewport persists to the store on move-end and is restored on
 *   mount, so view switches are zero-jump even if the Canvas unmounts.
 */
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ControlButton,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
  type NodeMouseHandler,
  type OnMoveEnd,
  type OnMoveStart,
} from "@xyflow/react";
import { edgeKeyOf } from "alchemy/Dashboard/Document";
import { Maximize } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCanvasLayout } from "../layout/useCanvasLayout.ts";
import {
  dashboardStore,
  requestFit,
  setPositions,
  setSelectedFqn,
  setUserPanned,
  setViewport,
  useFitRequest,
  type XY,
} from "../store.ts";
import { useThemeMode } from "../themeMode.ts";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  ResourceNode,
  type CanvasNode,
} from "./ResourceNode.tsx";

const nodeTypes = { resource: ResourceNode };

const FIT_VIEW = { padding: 0.2, maxZoom: 1.25 };
const PRO_OPTIONS = { hideAttribution: true };
const ORIGIN: XY = { x: 0, y: 0 };

// hoisted edge style/marker constants — no fresh literals per render.
// Colors are CSS custom-property strings, so [data-theme] re-themes edges
// with ZERO re-renders (the constants keep identity; the vars flip).
const BINDING_STYLE = {
  stroke: "var(--alc-terracotta)",
  strokeDasharray: "5 4",
};
const DEPENDENCY_STYLE = { stroke: "var(--alc-hairline-3)" };
const BINDING_MARKER = {
  type: MarkerType.ArrowClosed,
  color: "var(--alc-terracotta)",
  width: 16,
  height: 16,
};
const DEPENDENCY_MARKER = {
  type: MarkerType.ArrowClosed,
  color: "var(--alc-hairline-3)",
  width: 16,
  height: 16,
};
// canvas dot grid — hairline on the page token
const BACKGROUND_DOT_COLOR = "var(--alc-hairline-2)";

/**
 * Stable per-fqn `data` objects: the same fqn always reuses the same
 * `{ fqn }` reference, so rebuilding the node array never feeds a fresh
 * literal into a memoized ResourceNode.
 */
const nodeDataByFqn = new Map<string, { fqn: string }>();
const nodeDataOf = (fqn: string): { fqn: string } => {
  let data = nodeDataByFqn.get(fqn);
  if (data === undefined) {
    data = { fqn };
    nodeDataByFqn.set(fqn, data);
  }
  return data;
};

/**
 * Hashes whose first layout already auto-fit. Module-level so a Canvas
 * remount (view switch, if the host chooses to unmount) never re-fits a
 * structure the user has already seen — zero jump either way.
 */
const fittedHashes = new Set<string>();

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

function CanvasInner() {
  const { hash, fqns, visualEdges, positions, layouted } = useCanvasLayout();
  // resolved theme drives ONLY React Flow's colorMode (a string prop) —
  // all actual colors flow through CSS vars, so a theme flip re-renders
  // just this component, never the nodes.
  const { resolved } = useThemeMode();
  const fitRequest = useFitRequest();
  const { fitView } = useReactFlow();

  // React Flow node array — controlled, so drags flow through
  // applyNodeChanges (which clones only the dragged node).
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const hashRef = useRef(hash);
  hashRef.current = hash;

  // Rebuild only when the structure (hash → fqns) or its positions change;
  // nodes whose position is unchanged keep their object identity.
  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      const next = fqns.map((fqn): CanvasNode => {
        const position = positions.get(fqn) ?? ORIGIN;
        const existing = byId.get(fqn);
        if (
          existing !== undefined &&
          existing.position.x === position.x &&
          existing.position.y === position.y
        ) {
          return existing;
        }
        return {
          id: fqn,
          type: "resource",
          position: { x: position.x, y: position.y },
          data: nodeDataOf(fqn),
          // Fixed dimensions: nodes render at a known size (ResourceNode sets
          // the same constants), so React Flow treats them as measured
          // immediately. Without this, the rebuild-on-position-change effect
          // replaces node objects and wipes RF's measured dimensions —
          // `nodesInitialized` never turns true and edges silently never
          // render.
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        };
      });
      return next.length === previous.length &&
        next.every((node, index) => node === previous[index])
        ? previous
        : next;
    });
  }, [fqns, positions]);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  // Persist a drag into the position cache for this hash, so hand-tuned
  // coordinates survive view switches exactly like ELK output.
  const onNodeDragStop = useCallback(() => {
    const dragged = new Map<string, XY>();
    for (const node of nodesRef.current) {
      dragged.set(node.id, { x: node.position.x, y: node.position.y });
    }
    setPositions(hashRef.current, dragged);
  }, []);

  // Edge array — pure function of the structural hash (visualEdges is
  // memoized on it), stable edgeKeyOf ids, hoisted styles.
  const edges = useMemo<Edge[]>(
    () =>
      visualEdges.map((edge) => ({
        id: edgeKeyOf({
          kind: edge.binding ? "binding" : "dependency",
          source: edge.source,
          target: edge.target,
        }),
        source: edge.source,
        target: edge.target,
        animated: edge.binding,
        style: edge.binding ? BINDING_STYLE : DEPENDENCY_STYLE,
        markerEnd: edge.binding ? BINDING_MARKER : DEPENDENCY_MARKER,
      })),
    [visualEdges],
  );

  // Auto-fit exactly once per never-seen hash, when its first real layout
  // lands — never on decorations, never after the user panned.
  useEffect(() => {
    if (!layouted || fqns.length === 0 || fittedHashes.has(hash)) {
      return;
    }
    fittedHashes.add(hash);
    if (dashboardStore.getState().layout.userPanned) {
      return;
    }
    // next frame, after React Flow has measured the repositioned nodes
    const frame = requestAnimationFrame(() => {
      void fitView(FIT_VIEW);
    });
    return () => cancelAnimationFrame(frame);
  }, [layouted, hash, fqns, fitView]);

  // Explicit Fit button (store bumps fitRequest and clears userPanned).
  const lastFitRequest = useRef(fitRequest);
  useEffect(() => {
    if (fitRequest === lastFitRequest.current) {
      return;
    }
    lastFitRequest.current = fitRequest;
    void fitView(FIT_VIEW);
  }, [fitRequest, fitView]);

  // Restore the persisted viewport on mount (view switches are zero-jump);
  // read once — live updates flow the other way via onMoveEnd.
  const initialViewport = useRef(
    dashboardStore.getState().layout.viewport,
  ).current;

  const onMoveStart = useCallback<OnMoveStart>((event) => {
    // programmatic moves (fitView) carry no event — only user gestures arm
    // the pan latch that disables auto-fit
    if (event !== null) {
      setUserPanned(true);
    }
  }, []);

  const onMoveEnd = useCallback<OnMoveEnd>((_event, viewport) => {
    setViewport(viewport);
  }, []);

  const onNodeClick = useCallback<NodeMouseHandler<CanvasNode>>(
    (_event, node) => setSelectedFqn(node.id),
    [],
  );

  const onPaneClick = useCallback(() => setSelectedFqn(undefined), []);

  return (
    <ReactFlow<CanvasNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStop={onNodeDragStop}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onMoveStart={onMoveStart}
      onMoveEnd={onMoveEnd}
      {...(initialViewport !== undefined
        ? { defaultViewport: initialViewport }
        : {})}
      minZoom={0.2}
      proOptions={PRO_OPTIONS}
      colorMode={resolved}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable={false}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color={BACKGROUND_DOT_COLOR}
      />
      <Controls showInteractive={false} showFitView={false}>
        <ControlButton onClick={requestFit} title="fit view">
          <Maximize size={12} />
        </ControlButton>
      </Controls>
    </ReactFlow>
  );
}
