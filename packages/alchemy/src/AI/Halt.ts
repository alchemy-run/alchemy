import type * as S from "effect/Schema";
import type { EventSource } from "./EventSource.ts";

/**
 * A control ref that wires a {@link Process}'s exit signal.
 *
 * A charter that wires no halt is typed as perpetual (`Out = never`) — the
 * absence of an exit signal is carried by the loop's own type, not by a
 * constructor error. Consumers of an unhalted loop hold an
 * `Effect<never, …>`, which is unusable in exactly the right way; declaring
 * a ring intentionally perpetual (with the health signals that substitute
 * for an exit) is what `AI.never` is for, and the Kernel lints undeclared
 * perpetuity at interpretation time.
 *
 * The halt determines the process's `Out` channel, and the exit has
 * three SOURCES (reassess §B), symmetric with triggers (`AI.on(source)`
 * derives `In`; `AI.until(source)` derives `Out`):
 *
 * - **model-declared** — `AI.until\`…\`` / `AI.until(schema)\`…\``: the
 *   model ends the run by calling the `resolve` tool when it judges the
 *   prose condition met. `Out = void` or `Schema["Type"]`.
 * - **machine-observed** — `AI.until(eventSource)`: the run ends when a
 *   world event arrives (a GitHub issue closing, a CI run going green).
 *   There is NO `resolve` tool — the world declares the exit, not the
 *   model's claim (the reconciler doctrine transposed to exits:
 *   observation > claim). `Out =` the event's payload; the source's
 *   channel tag joins `Req`.
 * - **perpetual** — `AI.never\`…\``: no exit. `Out = never`.
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
  /**
   * A machine-observed exit: the run settles when this source delivers a
   * matching event (no `resolve` tool). Present iff `AI.until(source)`.
   * Stored loosely (`any`) so the `Out`-parameterized `match` never
   * makes `Halt<_, never>` fail `Extract<_, Halt<any, any>>` by
   * contravariance; the caller-facing types come from the `until`
   * overload's return, not these fields.
   */
  source?: EventSource<any, any, any>;
  /**
   * Correlates events to runs: settle only when `match(item, event)`.
   * Defaults to "any event from the source" — correct for single-run
   * demos; concurrent runs need a per-item predicate (e.g. issue number).
   */
  match?: (item: any, event: any) => boolean;
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
  // machine-observed: the world event IS the exit (Out = event payload)
  <In, Channel>(
    source: EventSource<In, Channel, any>,
    match?: (item: any, event: In) => boolean,
  ): Halt<[EventSource<In, Channel, any>], In>;
  // model-declared, typed value
  <Schema extends S.Top>(
    schema: Schema,
  ): <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => Halt<Refs, Schema["Type"]>;
} = ((first: TemplateStringsArray | S.Top | EventSource, ...rest: any[]) => {
  if (isTemplate(first)) return makeHalt("until", undefined, first, rest);
  if (isEventSourceLike(first)) {
    // a machine-observed halt: source in refs (so its channel tag joins
    // Req), no prose template of its own
    const halt = makeHalt(
      "until",
      (first as EventSource).schema,
      Object.assign([""], { raw: [""] }) as unknown as TemplateStringsArray,
      [first],
    );
    halt.source = first as EventSource;
    halt.match = rest[0];
    return halt;
  }
  return (template: TemplateStringsArray, ...refs: any[]) =>
    makeHalt("until", first as S.Top, template, refs);
}) as any;

const isEventSourceLike = (value: unknown): value is EventSource =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "EventSource";

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
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Halt";
