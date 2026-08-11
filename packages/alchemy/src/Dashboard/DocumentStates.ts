import type { PersistedState } from "../State/State.ts";
import {
  commit,
  edgeKeyOf,
  finishStructure,
  structureSignature,
  type DeploymentDocument,
  type DocumentEdge,
  type DocumentNode,
  type DocumentPatch,
  type Mutation,
} from "./Document.ts";
import { toGraph } from "./Graph.ts";

/**
 * Rebuild the persisted baseline from the state store. This is the ONE
 * pass allowed to RETIRE nodes: the structure is replaced wholesale with
 * the graph derived from `states` (plan overlay / structure ghosts must be
 * re-applied afterwards — caller order is `applyStates` → `applyPlan` →
 * `applyStructure`). Decorations/timelines/op-spans are left untouched:
 * they belong to the deployment, not the baseline.
 *
 * `keep` names nodes that must SURVIVE the rebuild even when `states`
 * lacks them: remote state stores are eventually consistent, so the
 * done-path readback can momentarily miss resources the run just wrote —
 * dropping them here would morph the topology for a beat and snap back
 * once the follow-up passes re-add them.
 *
 * Lives in its own module (not Document.ts) because `toGraph` →
 * `encodeState` → `Resource` drags the whole engine into the import graph —
 * this pass is server-only, while Document.ts is part of the browser-safe
 * core the SPA bundles.
 */
export const applyStates = (
  doc: DeploymentDocument,
  states: ReadonlyMap<string, PersistedState> | readonly PersistedState[],
  keep?: ReadonlySet<string>,
): Mutation => {
  const patches: DocumentPatch[] = [];
  const before = structureSignature(doc.structure);
  const previousNodes = doc.structure.nodes;
  const previousEdges = doc.structure.edges;
  const list = Array.isArray(states)
    ? (states as PersistedState[])
    : [...(states as ReadonlyMap<string, PersistedState>).values()];
  const { nodes, edges } = toGraph(list);
  doc.structure.nodes = new Map(
    nodes.map((n) => [n.fqn, { ...n } as DocumentNode]),
  );
  doc.structure.edges = new Map(
    edges.map((e) => [edgeKeyOf(e), { ...e } as DocumentEdge]),
  );
  if (keep !== undefined && keep.size > 0) {
    for (const [fqn, node] of previousNodes) {
      if (keep.has(fqn) && !doc.structure.nodes.has(fqn)) {
        doc.structure.nodes.set(fqn, node);
      }
    }
    for (const [key, edge] of previousEdges) {
      if (
        !doc.structure.edges.has(key) &&
        doc.structure.nodes.has(edge.source) &&
        doc.structure.nodes.has(edge.target)
      ) {
        doc.structure.edges.set(key, edge);
      }
    }
  }
  finishStructure(doc, before, patches);
  return commit(doc, patches);
};

/**
 * Merge ONE resource's freshly-persisted state into the document — called
 * as each resource reaches a terminal status during a live run, so its
 * outputs (attrs, links, bindings) appear the moment IT completes instead
 * of when the whole run's final state refresh lands. Preserves the plan
 * overlay, keeps the structural hash stable unless the node/edges are
 * genuinely new, and clears the ghost flag (the resource now exists).
 */
export const upsertNodeFromState = (
  doc: DeploymentDocument,
  state: PersistedState,
): Mutation => {
  const patches: DocumentPatch[] = [];
  const before = structureSignature(doc.structure);
  const { nodes, edges } = toGraph([state]);
  for (const fresh of nodes) {
    const existing = doc.structure.nodes.get(fresh.fqn);
    doc.structure.nodes.set(fresh.fqn, {
      ...fresh,
      // the plan overlay owns planAction; the run's decorations own status
      // display — keep the overlay's view of intent
      planAction: existing?.planAction,
    } as DocumentNode);
  }
  for (const edge of edges) {
    const key = edgeKeyOf(edge);
    if (
      !doc.structure.edges.has(key) &&
      doc.structure.nodes.has(edge.source) &&
      doc.structure.nodes.has(edge.target)
    ) {
      doc.structure.edges.set(key, { ...edge });
    }
  }
  finishStructure(doc, before, patches);
  return commit(doc, patches);
};
