import type * as S from "effect/Schema";
import type { Event } from "./Event.ts";

/**
 * The **message signature** (canon §2, designs/ai/business-processes.md):
 * a process is a function, and these expressions are its type, arranged
 * as {inbound, outbound} × {continuing, terminal}:
 *
 * |              | continues the run  | settles the run                 |
 * |--------------|--------------------|---------------------------------|
 * | **inbound**  | `${AI.when(X)}`    | `${AI.exit(AI.when(X), match?)}`|
 * | **outbound** | `${Event}` (mention = publish grant) | `${AI.until(schema)}` → `Out` |
 *
 * This module owns the marked signature expressions — `when`, `until`,
 * `exit`, `never` — the claims on a counterparty (`AI.when`: someone
 * must deliver; `AI.exit`: the kernel must correlate and settle). The
 * outbound-continuing corner needs no marker: an unmarked `${Event}`
 * mention IS the publish grant (see `Services.ts`/`Topology.ts`).
 */

/**
 * A signature expression declaring a {@link Process}'s **accepted
 * broadcast messages** (canon §2): `${AI.when(X)}` says "I accept
 * message X" — a PURE input declaration. It types the process's `In`,
 * renders in prose (as the sentence's own conjunction: "when X
 * arrives…"), and appears in topology. It does **not** deliver
 * anything: delivery is always explicit outside code (the front door
 * validates, adapts, and picks `send`/`dispatch` vs `steer(runKey, …)`).
 *
 * The union of a charter's `when` expressions is the process's `In`
 * channel — the work-item type a run is given, and the payload type of
 * `dispatch`/`send`. An *addressed* instruction needs no declaration:
 * its plain schema types `In`, delivered by `dispatch`/`send`/`steer`.
 *
 * Unlike `Halt` and `Fold`, `when` is not a template tag and carries no
 * nested expressions: the prose describing what to do with a work item
 * lives in the charter around the interpolation (`${AI.when(IssueOpened)}
 * run ${Triage}`), so its refs already flow through the charter itself.
 *
 * Because there is no auto-delivery, `when` contributes **nothing** to
 * the process's `Req` — the provisioning compile fence rides the
 * consuming call site (the front door that subscribes to the channel),
 * not the process that names its accepted messages.
 */
export interface When<In = unknown> {
  "~alchemy/Kind": "When";
  /** Phantom carrier for the accepted message's work-item type. */
  "~alchemy/In": In;
  sources: ReadonlyArray<Event<any>>;
}

/**
 * Declare the given broadcast messages as accepted inputs ("I accept
 * message X"). Declaration only — types `In`, renders in prose, joins
 * topology; the messages are delivered by explicit outside code
 * (`send`/`dispatch`), never auto-subscribed by the kernel.
 */
export const when = <const Sources extends Event<any>[]>(
  ...sources: Sources
): When<Sources[number] extends Event<infer In> ? In : never> =>
  ({
    "~alchemy/Kind": "When",
    sources,
  }) as any;

/**
 * Narrows to the `When` members of a ref union (generic for the same
 * variance reason as `isHalt`: a fixed `When<any>` is not assignable
 * to every parameterized `When`).
 */
export const isWhen = <T>(value: T): value is Extract<T, When<any>> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "When";

/**
 * A signature expression that wires a {@link Process}'s exit signal.
 *
 * A charter that wires no halt is typed as perpetual (`Out = never`) — the
 * absence of an exit signal is carried by the loop's own type, not by a
 * constructor error. Consumers of an unhalted loop hold an
 * `Effect<never, …>`, which is unusable in exactly the right way; declaring
 * a ring intentionally perpetual (with the health signals that substitute
 * for an exit) is what `AI.never` is for, and the Kernel lints undeclared
 * perpetuity at interpretation time.
 *
 * The halt determines the process's `Out` channel. A charter declares
 * at most two kinds (kernel-pruning ruling, 2026-07-17 — the
 * machine-observed `AI.exit(AI.when(source))` combinator is DELETED:
 * ending a run from the outside is the COMPONENT's job, never the
 * charter's):
 *
 * - **model-declared** — `AI.until\`…\`` / `AI.until(schema)\`…\``: the
 *   model ends the run by calling the `resolve` tool when it judges the
 *   prose condition met. `Out = void` or `Schema["Type"]`.
 * - **perpetual** — `AI.never\`…\``: no exit. `Out = never`.
 *
 * A charter with NO halt is **externally settled** — the kernel just
 * runs the loop (work round → park → steer wakes another round) until
 * the implementation Layer that consumed the wire ends the run with
 * `settle(key, event)`. `Out = unknown` (the settled event); how the
 * end reads in prose is ordinary sentence-writing ("GitHub closing the
 * issue ends this work"), not a combinator.
 *
 * For model-declared halts the condition is a nested template: both
 * human-readable policy and a typed dependency on interpolated signals,
 * whose refs flow into the process's `Req`.
 */
export interface Halt<Refs extends any[] = any[], Out = void> {
  "~alchemy/Kind": "Halt";
  /** Phantom carrier for the halt's resolution type. */
  "~alchemy/Out": Out;
  mode: "until" | "never";
  schema: S.Top | undefined;
  template: TemplateStringsArray;
  refs: Refs;
}

/**
 * Halt when the prose condition, backed by its interpolated signals, is met.
 *
 * With a schema, a halted run resolves with a typed value extracted per the
 * prose (`AI.until(PullRequestRef)\`…the ${pr} you opened\``); without one,
 * halting itself is the only payload (`Out = void`).
 */
export const until: {
  // model-declared, no value
  <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ): Halt<Refs, void>;
  // model-declared, typed value
  <Schema extends S.Top>(
    schema: Schema,
  ): <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => Halt<Refs, Schema["Type"]>;
} = ((first: TemplateStringsArray | S.Top, ...rest: any[]) => {
  if (isTemplate(first)) return makeHalt("until", undefined, first, rest);
  return (template: TemplateStringsArray, ...refs: any[]) =>
    makeHalt("until", first as S.Top, template, refs);
}) as any;

/**
 * Explicitly declare a perpetual ring (`Out = never`). The prose must name
 * the health signals that substitute for an exit.
 */
const never_ = <const Refs extends any[]>(
  template: TemplateStringsArray,
  ...refs: Refs
): Halt<Refs, never> => makeHalt("never", undefined, template, refs);

export { never_ as never };

const makeHalt = (
  mode: "until" | "never",
  schema: S.Top | undefined,
  template: TemplateStringsArray,
  refs: any[],
): any => ({
  "~alchemy/Kind": "Halt",
  mode,
  schema,
  template,
  refs,
});

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && "raw" in value;

/**
 * Narrows to the `Halt` members of a ref union. Generic so that guards
 * over heterogeneous `refs` tuples narrow to the exact `Halt<…>` members
 * (a fixed `Halt<any, any>` is not assignable to a `never`-Out halt, so
 * `Array.find`'s guard overload would silently refuse to narrow).
 */
export const isHalt = <T>(value: T): value is Extract<T, Halt<any, any>> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Halt";
