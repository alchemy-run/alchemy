import type * as S from "effect/Schema";
import type { EventSource } from "./EventSource.ts";

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
export interface When<In = unknown, Channels = never> {
  "~alchemy/Kind": "When";
  /** Phantom carrier for the accepted message's work-item type. */
  "~alchemy/In": In;
  /** Phantom carrier for the sources' channel tags. */
  "~alchemy/Channels": Channels;
  sources: ReadonlyArray<EventSource<any, any, any>>;
}

/**
 * Declare the given broadcast messages as accepted inputs ("I accept
 * message X"). Declaration only — types `In`, renders in prose, joins
 * topology; the messages are delivered by explicit outside code
 * (`send`/`dispatch`), never auto-subscribed by the kernel.
 */
export const when = <const Sources extends EventSource<any, any, any>[]>(
  ...sources: Sources
): When<
  Sources[number] extends EventSource<infer In, any, any> ? In : never,
  Sources[number]["~alchemy/Channel"]
> =>
  ({
    "~alchemy/Kind": "When",
    sources,
  }) as any;

/**
 * Narrows to the `When` members of a ref union (generic for the same
 * variance reason as `isHalt`: a fixed `When<any, any>` is not
 * assignable to a `never`-channel `When`).
 */
export const isWhen = <T>(value: T): value is Extract<T, When<any, any>> =>
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
 * The halt determines the process's `Out` channel, and the exit has
 * three SOURCES (reassess §B), symmetric with accepted messages
 * (`AI.when(source)` derives `In`; `AI.exit(AI.when(source))` derives
 * `Out`):
 *
 * - **model-declared** — `AI.until\`…\`` / `AI.until(schema)\`…\``: the
 *   model ends the run by calling the `resolve` tool when it judges the
 *   prose condition met. `Out = void` or `Schema["Type"]`.
 * - **machine-observed** — `AI.exit(AI.when(source, …))`: the run ends
 *   when a world event arrives (a GitHub issue closing, a CI run going
 *   green). There is NO `resolve` tool — the world declares the exit,
 *   not the model's claim (the reconciler doctrine transposed to exits:
 *   observation > claim). `Out =` the when's `In` (a union when the
 *   when is variadic); each source's channel tag joins `Req`.
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
   * A machine-observed exit: the run settles when one of these sources
   * delivers a matching event (no `resolve` tool). Present iff
   * `AI.exit(AI.when(...))` — ALL of the when's sources ride here (the
   * kernel subscribes each). Stored loosely (`any`) so the
   * `Out`-parameterized fields never make `Halt<_, never>` fail
   * `Extract<_, Halt<any, any>>` by contravariance; the caller-facing
   * types come from the `exit` signature's return, not these fields.
   */
  sources?: ReadonlyArray<EventSource<any, any, any>>;
  /**
   * Correlates events to runs: settle only when `match(item, event)`.
   * The rare per-exit override — the DEFAULT is per-source key equality
   * (`source.key(item) === source.key(event)` for key-bearing sources;
   * any event from the source otherwise).
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
  // model-declared, typed value
  <Schema extends S.Top>(
    schema: Schema,
  ): <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => Halt<Refs, Schema["Type"]>;
} = ((first: TemplateStringsArray | S.Top, ...rest: any[]) => {
  if (isTemplate(first)) return makeHalt("until", undefined, first, rest);
  if (isEventSourceLike(first) || isWhen(first)) {
    // the machine-observed form moved to the exit combinator — fail
    // loud at construction so a stale charter never splices garbage
    throw new Error(
      "machine-observed exits moved: AI.until(source) is gone — write AI.exit(AI.when(source), match?) instead",
    );
  }
  return (template: TemplateStringsArray, ...refs: any[]) =>
    makeHalt("until", first as S.Top, template, refs);
}) as any;

const isEventSourceLike = (value: unknown): value is EventSource =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "EventSource";

/**
 * The MACHINE-OBSERVED exit — a combinator over {@link when}: the run
 * ends when one of the accepted sources delivers a correlated event.
 *
 * ```ts
 * ${AI.exit(AI.when(GitHub.IssueClosed(repo)))`whether the merged pull
 * request closed it or a maintainer closed it by hand`}
 * ```
 *
 * - `Out` = the when's `In` — a UNION when the when is variadic
 *   (`AI.exit(AI.when(A, B))` exits on A or B).
 * - Each source's channel tag joins `Req` (the kernel observes the
 *   world on the process's behalf); the kernel subscribes every source.
 * - **Correlation precedence**: the explicit `match` override > the
 *   source's own `key` equality (`source.key(item) === source.key(event)`,
 *   the same function the front door steers by) > any event from the
 *   source.
 * - The returned exit is ALSO callable as a template tag: uncalled it
 *   splices the sources' clause alone ("This run ends when:
 *   {descriptions}"); called with a template it joins the authored
 *   prose after an em dash. Nested refs in the prose flow into `Req`
 *   like any halt template.
 */
export const exit: {
  <In, Channels>(
    accepted: When<In, Channels>,
    match?: (item: any, event: In) => boolean,
  ): Halt<[EventSource<In, Channels, any>], In> &
    (<const Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ) => Halt<[...Refs, EventSource<In, Channels, any>], In>);
} = ((accepted: When<any, any>, match?: (item: any, event: any) => boolean) => {
  const sources = accepted.sources;
  const attach = (halt: any) => {
    halt.sources = sources;
    halt.match = match;
    return halt;
  };
  // Callable Halt: a template tag carrying the Halt fields (the guards
  // accept function-shaped kinds). The prose form's runtime refs are the
  // TEMPLATE's own (rendering zips them 1:1); the sources ride
  // `halt.sources` — their channel tags join Req through the declared
  // return type, which appends a source-typed pseudo-entry to Refs.
  const tag = (template: TemplateStringsArray, ...refs: any[]) =>
    attach(makeHalt("until", sources[0]?.schema, template, refs));
  return Object.assign(
    tag,
    attach(
      makeHalt(
        "until",
        sources[0]?.schema,
        Object.assign([""], { raw: [""] }) as unknown as TemplateStringsArray,
        [],
      ),
    ),
  );
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
 *
 * Accepts function-shaped values: a machine-observed exit
 * (`AI.exit(AI.when(...))`) is a callable Halt — a template tag
 * carrying the Halt fields.
 */
export const isHalt = <T>(value: T): value is Extract<T, Halt<any, any>> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Halt";
