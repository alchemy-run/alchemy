import type * as S from "effect/Schema";

/**
 * Who publishes a source (canon §2a ruling 4). Affordances are
 * owner-sensitive:
 *
 * - `"org"` (the default) — an org-internal broadcast: a process may
 *   publish it, so a bare `${X}` mention IS the publish grant (joins
 *   `emits` topology, permits `ctx.emit(X, payload)`).
 * - `"world"` — a provider-catalog source (`GitHub.IssueOpened(repo)`):
 *   the WORLD publishes it, a process never can, so a bare mention
 *   affords nothing — it renders as vocabulary (the event's name) and
 *   grants no publish topology and no `ctx.emit`. Inbound use is always
 *   marked: `AI.when(X)` to accept, `AI.exit(AI.when(X))` for a
 *   machine-observed exit.
 */
export type EventOwner = "world" | "org";

export interface EventOptions<Owner extends EventOwner> {
  owner: Owner;
  /**
   * The term's rendered clause (the combinator contract from the prose
   * guide, §2.2): a present-tense phrase completing "when ___" — e.g.
   * "an issue opens in alchemy-run/test-alchemy". The *term author*
   * writes the clause once; every charter author composes sentences
   * with it: `AI.when(X)` renders "when {description}", and a
   * machine-observed exit (`AI.exit(AI.when(X))`) renders it as the
   * exit clause ("This run ends when: {description}"). Without one,
   * the marked expressions fall back to the source's name — legible,
   * but write the description.
   */
  description?: string;
  /**
   * The source's **natural identity key** — a pure function from a
   * payload (or a payload-shaped work item) to the string naming the
   * world entity the event is about (e.g. `owner/repo#number`).
   * Declared ONCE by whoever defines the event family; every consumer
   * derives correlation from it: delivery code uses it to address the
   * running actor (first key ⇒ `send` creates the run, seen key ⇒
   * `steer`), and machine-observed exits settle on key equality
   * between the run's work item and the delivered event. May return
   * `undefined` when the value doesn't carry the identity fields (e.g.
   * a plain-string work item) — consumers fall back to their keyless
   * behavior.
   */
  key?: (payload: any) => string | undefined;
}

/**
 * A named, typed message declaration — the event vocabulary a
 * {@link Process} charter composes with: `AI.when(X)` to accept
 * (typing `In`), `AI.exit(AI.when(X))` for a machine-observed exit,
 * or a bare `${X}` mention as a publish grant (org-owned only).
 *
 * An `Event` is **pure definition data** — kernel-pruning ruling
 * (2026-07-17): it declares vocabulary, typing, affordance, and
 * identity; it carries NO provisioning config and nothing subscribes
 * through it. Delivery is user-space code (the process's
 * implementation Layer consumes the wire and calls
 * `send`/`steer`/`settle`); whether an assembly also routes
 * org-internal emissions anywhere (e.g. `AI.EventBus`) is that
 * assembly's business, never this declaration's.
 *
 * - `~alchemy/Name` (aliased as `name`) — deterministic identity
 *   (`github.issues.opened/owner/repo`).
 * - `schema` — the payload type (`In`).
 * - `~alchemy/Owner` — who publishes it (see {@link EventOwner}).
 *   World-owned sources (provider catalogs) afford nothing by bare
 *   mention; the constructors that build them narrow the field to the
 *   `"world"` literal so the gate holds at the type level too.
 * - `description` / `key` — the combinator clause and the correlation
 *   function (see {@link EventOptions}).
 */
export interface Event<In = unknown> {
  "~alchemy/Kind": "Event";
  "~alchemy/Name": string;
  /** Who publishes this source; absent/`"org"` = org-internal. */
  "~alchemy/Owner"?: EventOwner;
  /**
   * The source's readable name — an alias of `~alchemy/Name`. The
   * inert-mention escape hatch: `${X.name}` interpolates a plain string
   * (renders the name, grants nothing), where a bare `${X}` is the
   * publish grant.
   */
  name: string;
  /**
   * The term's rendered clause — a present-tense phrase completing
   * "when ___" (see {@link EventOptions.description}). Composed
   * by the marked expressions (`AI.when(X)` → "when {description}";
   * the machine-observed exit `AI.exit(AI.when(X))` → the exit
   * clause); a bare mention still renders only the NAME (descriptions
   * never leak into noun position). `undefined` ⇒ the expressions fall
   * back to the name.
   */
  description?: string;
  /**
   * The source's natural identity key (see
   * {@link EventOptions.key}) — the ONE correlation function
   * delivery code steers by and machine-observed exits settle by.
   * `undefined` ⇒ keyless (delivery always `send`s; an exit settles on
   * any event from the source).
   */
  key?: (payload: any) => string | undefined;
  schema: S.Top & { readonly Type: In };
}

export const Event: {
  <const Name extends string, Schema extends S.Top>(
    name: Name,
    schema: Schema,
  ): Event<Schema["Type"]>;
  // owner-marked: the returned type narrows `~alchemy/Owner` to the
  // literal so Services.ts/topology can gate the bare mention at the
  // type level (canon §2a ruling 4)
  <
    const Name extends string,
    Schema extends S.Top,
    const Owner extends EventOwner,
  >(
    name: Name,
    schema: Schema,
    options: EventOptions<Owner>,
  ): Event<Schema["Type"]> & {
    "~alchemy/Owner": Owner;
  };
} = (name: string, schema: S.Top, options?: EventOptions<EventOwner>): any => ({
  "~alchemy/Kind": "Event",
  "~alchemy/Name": name,
  "~alchemy/Owner": options?.owner ?? "org",
  name,
  description: options?.description,
  key: options?.key,
  schema,
});

export const isEvent = (value: unknown): value is Event<unknown> =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Event";

/**
 * Is the source world-owned (canon §2a ruling 4)? A world-owned source's
 * bare mention is inert vocabulary — no publish grant, no `emits`
 * topology, and `ctx.emit` of it is a defect: a process cannot publish
 * what only the world emits.
 */
export const isWorldOwned = (source: Event<any>): boolean =>
  source["~alchemy/Owner"] === "world";
