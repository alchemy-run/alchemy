import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Thread } from "./Thread.ts";
import type { In, Out, Thing } from "./Thing.ts";
import type { Services } from "./Fragment.ts";
import { makeSource, type Source } from "./Source.ts";

/**
 * The things a template splices as INPUTS — a bare `${q}` (the
 * default) or an explicit `${AI.in(repo, number)}`.
 */
type InThing<Refs> =
  Refs extends In<infer T> ? T : Refs extends Thing ? Refs : never;

type ParamOf<Refs, N> = Extract<
  InThing<Refs>,
  Thing & { readonly "~alchemy/Name": N }
>;

// per-key PRECISE: each parameter name maps to ITS schema's type (not
// the union of every parameter's type in the template), and a
// `S.optionalKey` schema makes the KEY optional — mirroring exactly
// what the compiled S.Struct does at runtime.
/** Any `Data.TaggedError` / `Schema.TaggedError` class — both compile
 *  to a constructor whose instances are `Error`s. */
export type ErrorTerm = new (...args: any[]) => Error;

/**
 * The tool's DECLARED failures, from the error classes its template
 * splices — error mention-is-presence, exactly like `${Thing}`
 * declares a field:
 *
 * ```ts
 * class Missing extends Data.TaggedError("Missing")<{ path: string }> {}
 *
 * export class ReadFile extends AI.Tool<ReadFile>()("readFile")`
 *   Read ${path} — answers ${AI.out(content)}. Fails with ${Missing}
 *   when it does not exist.` {}
 * // → readFile(input: { path: string }): Effect<{ content: string }, Missing>
 * ```
 *
 * A failure the template never mentions is not in the error channel:
 * it is a DEFECT (`Effect.die`), and the model is told as much.
 */
export type ToolErrors<Refs> = Refs extends ErrorTerm
  ? InstanceType<Refs>
  : never;

export type ToolParameters<Refs> = {
  [
    N in InThing<Refs>["~alchemy/Name"] as ParamOf<
      Refs,
      N
    >["schema"]["~type.optionality"] extends "optional"
      ? never
      : N
  ]: ParamOf<Refs, N>["schema"]["Type"];
} & {
  [
    N in InThing<Refs>["~alchemy/Name"] as ParamOf<
      Refs,
      N
    >["schema"]["~type.optionality"] extends "optional"
      ? N
      : never
  ]?: ParamOf<Refs, N>["schema"]["Type"];
};

/** The things a template splices as OUTPUTS (`${AI.out(title, body)}`). */
type OutThing<Refs> = Refs extends Out<infer T> ? T : never;
type OutOf<Refs, N> = Extract<
  OutThing<Refs>,
  Thing & { readonly "~alchemy/Name": N }
>;

/**
 * The tool's DECLARED return type — the record of its out-things,
 * output mention-is-presence exactly like `${Thing}` declares an
 * input field:
 *
 * ```ts
 * const hits = AI.Thing("hits", S.Array(Row))`Matching rows.`;
 *
 * const search = yield* AI.Tool("search")`
 *   Search for ${AI.in(q)}. Answers ${AI.out(hits)}.`(
 *   Effect.fn(function* (p: { q: string }) {
 *     return { hits: yield* find(p.q) }; // ← type-checked
 *   }),
 * );
 * // codemode: search(input: { q: string }): Promise<{ hits: Array<…> }>
 * ```
 *
 * OUTPUT TYPES ARE STRICT, EXPLICIT, AND LIVE IN THE PROSE: the
 * `${AI.out(…)}` splices are the ONLY way to declare an output — there
 * is no returns-schema argument. A template with no out-splices means
 * the tool RETURNS VOID: it acts, it does not answer. Codemode is why:
 * the generated signature the model programs against is only as good
 * as the declared return type, and a bare confirmation string
 * ("closed", "card posted") tells a program nothing — answer a record
 * or answer nothing.
 */
export type ToolReturns<Refs> = 0 extends 1 & Refs
  ? any // erased (`Tool<any, any>`) — driver internals, never a call site
  : [OutThing<Refs>] extends [never]
    ? void
    : {
        [
          N in OutThing<Refs>["~alchemy/Name"] as OutOf<
            Refs,
            N
          >["schema"]["~type.optionality"] extends "optional"
            ? never
            : N
        ]: OutOf<Refs, N>["schema"]["Type"];
      } & {
        [
          N in OutThing<Refs>["~alchemy/Name"] as OutOf<
            Refs,
            N
          >["schema"]["~type.optionality"] extends "optional"
            ? N
            : never
        ]?: OutOf<Refs, N>["schema"]["Type"];
      };

/**
 * A `Tool` term is a **capability term** (with `Thing` — design §1
 * taxonomy): never interpreted by the Driver, it is compiled *into* its
 * host process term's turns — the template becomes the toolkit
 * description, the interpolated `Thing` refs become the schema, and
 * the `<Self>()` tag resolves its implementation (the physics) from
 * ambient context. A tool has no inbox, no sessions, and no ring.
 */
export interface Tool<
  Name extends string = string,
  Refs extends any[] = any[],
> {
  "~alchemy/Kind": "Tool";
  "~alchemy/Name": Name;
  refs: Refs;
  template: TemplateStringsArray;
  /**
   * The file this tool is defined in — present when the term was
   * declared as `AI.Tool<Self>(import.meta)(name)`. Splice
   * `${Bash.source}` to mention the file (a path) without granting the
   * tool (see Source.ts).
   */
  readonly source?: Source;
  params: {
    [p in keyof ToolParameters<Refs[number]>]: ToolParameters<Refs[number]>[p];
  };
  impl: (props: this["params"]) => Effect.Effect<any, any, any>;
  new (): Tool<Name, Refs>;
  /**
   * Apply the implementation — SYNCHRONOUSLY. The result is a
   * {@link ToolDef}: pure declaration data (name, prose, typed I/O,
   * and the INIT Effect), constructed with no Effect run.
   *
   * The INIT (`Effect<handler, never, Req>`) runs once where the host
   * agent's Layer builds — at plan time in the deploy process and once
   * per isolate at runtime. Bindings and services are acquired there;
   * the returned HANDLER runs per call, its only implicit input the
   * current session (`AI.Thread`).
   *
   * Splicing the def into a charter template grants the tool and
   * charges `Req | Services<Refs>` to the charter Layer's requirement
   * channel — a tool's dependencies are a type-level fact.
   *
   * (Transitional: the def is also a yieldable Effect resolving to
   * the legacy inline {@link ToolImpl}, so pre-static charters that
   * `yield*` the application keep working until they migrate.)
   */
  <
    Err extends ToolErrors<Refs[number]> = never,
    Req = never,
    HandlerR extends Thread | RuntimeContext = never,
  >(
    impl: Effect.Effect<
      (
        props: this["params"],
      ) => Effect.Effect<ToolReturns<Refs[number]>, Err, HandlerR>,
      never,
      Req
    >,
  ): ToolDef<this, Err, Req | Services<Refs>>;
  <Err extends ToolErrors<Refs[number]> = never, Req = never>(
    impl: (
      props: this["params"],
    ) => Effect.Effect<ToolReturns<Refs[number]>, Err, Req>,
  ): ToolDef<this, Err, Req | Services<Refs>>;
}

export interface ToolImpl<
  T extends Tool<any, any> = any,
  Err = any,
  Req = any,
> {
  "~alchemy/Kind": "ToolImpl";
  tool: T;
  impl: (props: T["params"]) => Effect.Effect<any, Err, Req>;
  new (): {};
}

/**
 * A TOOL DEFINITION — the static value `AI.Tool(name)`…`(init)`
 * produces, synchronously: the term (name, prose, typed I/O) plus the
 * INIT Effect that builds its handler.
 *
 * The def is pure declaration data, mintable at module scope with no
 * Effect run — which is what makes a tool's dependencies (and its
 * BINDINGS, acquired inside `init`) statically knowable: the graph
 * walks defs without executing anything, and the plan-phase Layer
 * build executes `init` under attribution to learn the permissions.
 *
 * Splice a def into a charter template to grant the tool; `Req`
 * charges the charter Layer's requirement channel.
 *
 * Transitional: a def is also a yieldable Effect resolving to the
 * legacy {@link ToolImpl} (init runs at the yield), so pre-static
 * charters that `yield*` the application keep working during the
 * migration.
 */
export interface ToolDef<
  T extends Tool<any, any> = any,
  Err = any,
  Req = any,
> extends Effect.Effect<ToolImpl<T, Err, never>, never, Req> {
  readonly "~alchemy/Kind": "ToolDef";
  readonly tool: T;
  /**
   * INIT — runs once where the host agent's Layer builds (plan time
   * and isolate boot): acquires bindings/services, returns the
   * per-call HANDLER. The handler's one implicit input is the current
   * session (`AI.Thread`); everything else arrives as arguments.
   */
  readonly init: Effect.Effect<
    (props: T["params"]) => Effect.Effect<any, Err, any>,
    never,
    Req
  >;
}

export const isToolDef = (value: unknown): value is ToolDef =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "ToolDef";

export const Tool: {
  <Name extends string>(
    name: Name,
  ): {
    <Refs extends any[]>(
      template: TemplateStringsArray,
      ...refs: Refs
    ): Tool<Name, Refs>;
  };
  /**
   * `AI.Tool<Self>()(name)` declares the tag; `AI.Tool<Self>(import.meta)(name)`
   * additionally records the defining file as `source` (see Source.ts).
   */
  <Self>(meta?: ImportMeta): {
    <Name extends string>(
      name: Name,
    ): {
      <Refs extends any[]>(
        template: TemplateStringsArray,
        ...refs: Refs
      ): Tool<Name, Refs> &
        Context.Service<
          Self,
          // the service IS the callable — a Layer whose construction
          // needs runtime context (a binding client) unwraps it inside
          // its own Layer.effect, so `yield* SomeTool` is always the
          // function, never an Effect to normalize
          (
            input: ToolParameters<Refs[number]>,
          ) => Effect.Effect<
            ToolReturns<Refs[number]>,
            ToolErrors<Refs[number]>,
            RuntimeContext
          >
        >;
    };
  };
} = ((nameOrMeta?: string | ImportMeta) =>
  typeof nameOrMeta === "string"
    ? (template: TemplateStringsArray, ...refs: any[]) =>
        makeTool(nameOrMeta, template, refs)
    : (name: string) =>
        (template: TemplateStringsArray, ...refs: any[]) =>
          makeTool(name, template, refs, nameOrMeta)) as any;

// The Context.Service tag is what gives each Tool a distinct ServiceMap
// key (`alchemy/AI/Tool/{name}`) — without it every Tool resolves to the
// same (undefined) key and the last-provided handler silently serves ALL
// tools in the context. The tag is grafted on via the prototype chain
// (not `class extends`) because the term must stay CALLABLE: `Grep(impl)`
// is the ToolImpl form, and calling a class throws.
const makeTool = (
  name: string,
  template: TemplateStringsArray,
  refs: any[],
  meta?: ImportMeta,
) => {
  const term = function (
    impl:
      | ((props: any) => Effect.Effect<any, any, any>)
      | Effect.Effect<(props: any) => Effect.Effect<any, any, any>, any, any>,
  ) {
    // SYNCHRONOUS application → a ToolDef. The INIT is the given
    // Effect (or the bare handler lifted): it runs once per host
    // Layer build, under attribution, and yields the handler.
    const init = Effect.isEffect(impl) ? impl : Effect.succeed(impl);
    // the def doubles as a yieldable Effect resolving to the legacy
    // ToolImpl — the transitional bridge for `yield*` call sites
    const def = Effect.map(init, (handler) => ({
      "~alchemy/Kind": "ToolImpl",
      tool: term,
      impl: handler,
    }));
    return Object.assign(def, {
      "~alchemy/Kind": "ToolDef",
      tool: term,
      init,
    });
  };
  Object.setPrototypeOf(
    term,
    Context.Service<any, any>()(`alchemy/AI/Tool/${name}`),
  );
  return Object.assign(term, {
    "~alchemy/Kind": "Tool",
    "~alchemy/Name": name,
    refs,
    template,
    ...(meta !== undefined ? { source: makeSource(meta, "Tool", name) } : {}),
  }) as any;
};

/**
 * A spliced ERROR class — `Data.TaggedError` and `Schema.TaggedError`
 * both produce a constructor whose prototype is an `Error`, which is
 * the one check that catches both.
 */
export const isErrorTerm = (value: unknown): value is ErrorTerm =>
  typeof value === "function" &&
  (value as { prototype?: unknown }).prototype instanceof Error;

/**
 * The tag a spliced error class declares: `Schema.TaggedError` carries
 * a static `_tag`; `Data.TaggedError` names the class after its tag.
 */
export const errorTag = (term: ErrorTerm): string => {
  const tag = (term as unknown as { _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : term.name;
};

export const isTool = (value: unknown): value is Tool<any, any> =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Tool";

/**
 * An inline tool — a `Tool` term applied to its implementation and
 * `yield*`ed in the charter's INIT
 * (`const park = yield* AI.Tool("park")`…`(() => …)`). Spliced into
 * the charter's prose, it grants the tool with its physics carried in
 * the splice: the closure form for session-local affordances (a tool that
 * flips a phase `Ref`, a persona-private verb no other term should
 * share).
 */
export const isToolImpl = (value: unknown): value is ToolImpl =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "ToolImpl";
