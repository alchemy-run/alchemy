import * as AI from "alchemy/AI";
import Engineering from "./engineering/Group.ts";
import { Head } from "./Head.ts";

/**
 * The ROOT GROUP — ⊥, the bottom of the lineage.
 *
 * A GROUP is the static, permanent structure the runtime hangs from
 * (threads and sessions are runtime-only things; groups are code). At
 * every group's core is a CHANNEL — the session of its HEAD, the
 * single-threaded point of view of the whole group, its management
 * supreme. The Root Group's channel IS the Root Thread: the one
 * conversation between the human who owns the company and the Head
 * who runs its autonomous side (`/attach/Head/root`).
 *
 * Everything derives from this group and carries its key in its own:
 * members (`root::manager`, `root::e-4f2a`), workspaces
 * (`root::ws-pr-1521`), calls, threads, proposals. The lineage is the
 * project — what the company is, is the history of this channel and
 * the trees that grew from it, all of it CODE in the repository the
 * company maintains (services/root), all of it versioned. A FORK of
 * the company is a second root key, not a rewrite — which is why
 * `ROOT` is a constant everything takes as a parameter rather than a
 * hardcode of its own.
 *
 * The inbound world (GitHub issues, pull requests, comments) does NOT
 * enter here: the engineering group owns it — `engineering/Triage.ts`
 * pumps events into ITS channel, strictly in order. The Head hears
 * reports and escalations through ask-chains, not event spam; the
 * human hears the Head.
 */
export default class Root extends AI.Group<Root>(import.meta)("Root") {}

/** The company: the Head at the top, the engineering group under it.
 *  Completed in ApiWorker.ts by providing the members' Layers. */
export const RootChart = Root.make`
  The company that builds and maintains the Alchemy products. ${Head}
  leads its autonomous side — its session is this group's channel, the
  ROOT THREAD the humans hold. Under it: ${Engineering}
`;

// The lineage constants live in their own LEAF module (Lineage.ts) so
// the conversation seams can import them without importing the chart;
// re-exported here for the top-level composition's convenience.
export { lineage, nameOfKey, ROOT, rootOf } from "./Lineage.ts";
