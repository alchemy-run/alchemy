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
 * Lives in its own module (not Document.ts) because `toGraph` →
 * `encodeState` → `Resource` drags the whole engine into the import graph —
 * this pass is server-only, while Document.ts is part of the browser-safe
 * core the SPA bundles.
 */
export const applyStates = (
  doc: DeploymentDocument,
  states: ReadonlyMap<string, PersistedState> | readonly PersistedState[],
): Mutation => {
  const patches: DocumentPatch[] = [];
  const before = structureSignature(doc.structure);
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
  finishStructure(doc, before, patches);
  return commit(doc, patches);
};
