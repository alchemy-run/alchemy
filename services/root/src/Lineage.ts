/**
 * The LINEAGE constants — the root key and how session keys derive
 * from it. A LEAF module on purpose: charters are static templates
 * now (`Head.make`…``), evaluated at module load, so anything the
 * conversation seams (Ask, Call, the workspace tools) import must
 * never lead back to the org chart (`Root.ts` → `Group.ts` → the
 * agents) or the cycle trips the templates' evaluation.
 */

/** The one root channel — the Head's session key. */
export const ROOT = "root";

/** A session key under this root: `lineage("manager")` →
 *  `root::manager`. The `::` segments are the lineage —
 *  `machineKey` (sandbox) and colleague names (chat) read them. */
export const lineage = (name: string): string => `${ROOT}::${name}`;

/** The root a lineage key belongs to (`root::ws-pr-1` → `root`). */
export const rootOf = (key: string): string => key.split("::")[0]!;

/** A session key's IDENTITY — the agent colleagues address
 *  (`root` → "head"; `root::manager` → "manager";
 *  `root::engineer::p-x1` → "engineer": an agent may hold many
 *  sessions — one per thread it works — but the identity is the
 *  segment right under the root, the same whichever session speaks). */
export const nameOfKey = (key: string): string => {
  if (key === ROOT) return "head";
  return key.split("::")[1]!;
};
