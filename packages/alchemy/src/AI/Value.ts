import type * as Context from "effect/Context";

/**
 * Dynamic prose within a static upper bound (reassess §F): interpolate
 * a service-resolved string into an otherwise static charter —
 * `${AI.value(RepoState)}` drops the current repo summary, a user's
 * name, retrieved context. The unifying principle: `Req` is a static
 * upper bound on capability; realization is dynamic within it.
 *
 * - The tag joins the term's `Req` (like a tool ref) — the value is a
 *   declared dependency, provided by a Layer, so `AI.topology` sees a
 *   typed hole and capability reasoning stays honest.
 * - Resolution happens at INTERPRETATION time (when `AI.layer`/`AI.
 *   process` builds the term's ring, with ambient context available),
 *   not per-run — so `promptHash` stamps once per interpretation and
 *   provider prompt-caching stays effective. Per-*run* data (the user
 *   message, RAG results) rides `In` / tool results, never the system
 *   prompt.
 *
 * Deliberately NOT a `(ctx) => string` charter function: that would
 * erase the refs tuple and kill `Req` derivation. The value is a plain
 * service whose Layer may compute it however it likes (the dynamism is
 * in the Layer, the STRUCTURE stays static).
 */
export interface Value<Id = any> {
  "~alchemy/Kind": "Value";
  /** Phantom carrier for the resolved-value service's Identifier. */
  "~alchemy/Id": Id;
  /** The service tag whose (string) value is spliced into the prose. */
  tag: Context.Service<Id, string>;
}

export const value = <Id>(tag: Context.Service<Id, string>): Value<Id> =>
  ({
    "~alchemy/Kind": "Value",
    tag,
  }) as Value<Id>;

export const isValue = (v: unknown): v is Value =>
  (typeof v === "object" || typeof v === "function") &&
  v !== null &&
  (v as Record<string, unknown>)["~alchemy/Kind"] === "Value";
