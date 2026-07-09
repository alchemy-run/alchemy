import type * as S from "effect/Schema";

/**
 * A control ref that wires a {@link Loop}'s exit signal.
 *
 * A charter that wires no halt is typed as perpetual (`Out = never`) — the
 * absence of an exit signal is carried by the loop's own type, not by a
 * constructor error. Consumers of an unhalted loop hold an
 * `Effect<never, …>`, which is unusable in exactly the right way; declaring
 * a ring intentionally perpetual (with the health signals that substitute
 * for an exit) is what `AI.never` is for, and the Kernel lints undeclared
 * perpetuity at interpretation time.
 *
 * The halt determines the loop's `Out` channel:
 *
 * - `AI.until\`…\`` — halts when the prose condition (backed by the
 *   interpolated signals, e.g. `${Bash}`) is met. `Out = void`.
 * - `AI.until(schema)\`…\`` — as above, but a halted run resolves with a
 *   value of the schema's type. `Out = Schema["Type"]`.
 * - `AI.never\`…\`` — an explicit declaration that the ring is perpetual;
 *   the prose must name the health signals that substitute for an exit.
 *   `Out = never` — the ring's `run` is an `Effect<never, …>` that never
 *   returns, which is exactly what Effect already means by `never`.
 *
 * The halt condition is a nested template: simultaneously human-readable
 * policy and a typed dependency on concrete signals. Nested refs flow into
 * the loop's `Req`. The signal may equally be produced by a machine
 * (`${Bash}` reports green) or by a human (`a maintainer closes the
 * experiment`, arriving as a GitHub event) — bounded-by-machine and
 * bounded-by-human are the same type.
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
  <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ): Halt<Refs, void>;
  <Schema extends S.Top>(
    schema: Schema,
  ): <const Refs extends any[]>(
    template: TemplateStringsArray,
    ...refs: Refs
  ) => Halt<Refs, Schema["Type"]>;
} = ((first: TemplateStringsArray | S.Top, ...refs: any[]) =>
  isTemplate(first)
    ? makeHalt("until", undefined, first, refs)
    : (template: TemplateStringsArray, ...refs: any[]) =>
        makeHalt("until", first, template, refs)) as any;

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
