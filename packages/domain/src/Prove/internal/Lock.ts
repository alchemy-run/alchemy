import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Aggregate from "../../Aggregate.ts";
import * as Check from "./Check.ts";
import * as Interpreter from "./Interpreter.ts";
import * as Paths from "./Paths.ts";
import * as Smt from "./Smt.ts";
import * as Source from "./Source.ts";
import * as Symbolic from "./Symbolic.ts";
import * as Value from "./Value.ts";

/** How a rule stands against the one it was locked as. */
export type Comparison =
  /** Every state the rules allow now is one the locked rule allows. */
  | { readonly _tag: "Kept" }
  /** A state the rules allow now, that the locked rule refuses. */
  | { readonly _tag: "Weaker"; readonly state: unknown }
  | { readonly _tag: "Unknown"; readonly reason: string };

/** The most ways through a state's schema and a rule that two rules are compared on. */
const MAX_PATHS = 256;

/**
 * A rule's text with what a formatter changes taken out: two texts that are
 * the same after it are the same rule.
 */
export const normal = (source: string): string =>
  source.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "");

/**
 * Whether an aggregate's invariants allow a state the locked text of one of
 * them refuses. The locked text is read in the file as it is now: a function
 * it calls is the one the file has today.
 */
const compare = Effect.fn(function* (
  solver: Smt.Solver,
  loader: Source.Loader,
  interpreter: Interpreter.Interpreter,
  aggregate: Aggregate.Any,
  definition: Paths.Definition,
  name: string,
  locked: string,
) {
  const site: Value.Site = { module: definition.module, node: definition.node };
  const ast = Symbolic.typeOf(definition.state);
  if (!ast) return { _tag: "Unknown", reason: "the state is not a schema" } as const;
  const parsed = yield* loader.parse(definition.module.path, locked).pipe(Effect.result);
  if (Result.isFailure(parsed))
    return { _tag: "Unknown", reason: `the locked rule ${parsed.failure.message}` } as const;
  const real = (aggregate.definition.invariants ?? {}) as unknown as Record<
    string,
    (state: unknown) => boolean
  >;
  let unknown: string | undefined;
  let paths = 0;
  let prefix: ReadonlyArray<number> | undefined = [];
  while (prefix) {
    if (++paths > MAX_PATHS)
      return {
        _tag: "Unknown",
        reason: `there are more than ${MAX_PATHS} ways through it`,
      } as const;
    const run = new Value.Run(prefix);
    interpreter.current.run = run;
    const read = yield* Effect.gen(function* () {
      const state = Symbolic.symbolic(ast, "state", run);
      // Every invariant as it is now: the rule itself, and the others it stands beside.
      for (const check of yield* Paths.checks(interpreter, definition, state)) {
        if (Result.isFailure(check.condition)) {
          if (check.name === name) return yield* check.condition.failure;
          continue;
        }
        if (check.condition.success === "false") return yield* new Value.Infeasible();
        run.assume(check.condition.success);
      }
      const rule = yield* interpreter.evaluate(
        parsed.success,
        interpreter.moduleEnv(definition.module),
      );
      const value = yield* interpreter
        .call(rule, [state], site)
        .pipe(
          Effect.flatMap((value) => (value._tag === "Effect" ? value.run : Effect.succeed(value))),
        );
      const truth = yield* interpreter.truth(value, site);
      return { state, formula: typeof truth === "boolean" ? String(truth) : truth };
    }).pipe(
      Effect.map((made) => ({ _tag: "Read", ...made }) as const),
      Effect.catchTags({
        Infeasible: () => Effect.succeed({ _tag: "Infeasible" } as const),
        Rejected: () =>
          Effect.succeed({ _tag: "Unread", reason: "the locked rule fails" } as const),
        NotTranslated: (error) => Effect.succeed({ _tag: "Unread", reason: error.reason } as const),
      }),
    );
    prefix = Value.nextPrefix(run.taken);
    if (read._tag === "Unread") return { _tag: "Unknown", reason: read.reason } as const;
    if (read._tag === "Infeasible" || read.formula === "true") continue;
    const answer = yield* Check.solve(solver, run, read.formula);
    if (answer._tag === "Unsat") continue;
    if (answer._tag === "Unknown") {
      unknown = answer.reason;
      continue;
    }
    const built = Symbolic.concretize(read.state, answer.model, run.lists);
    if (!("value" in built)) {
      unknown = built.reason;
      continue;
    }
    const state = built.value;
    // The state has to be one the real rules allow: the prover may not read every one.
    let allowed = Schema.is(aggregate.definition.state)(state);
    for (const holds of Object.values(real))
      allowed &&= yield* Effect.try(() => holds(state)).pipe(Effect.orElseSucceed(() => false));
    if (allowed) return { _tag: "Weaker", state } as const;
    unknown = "the state the solver found is not one the real rules allow";
  }
  const made: Comparison =
    unknown === undefined ? { _tag: "Kept" } : { _tag: "Unknown", reason: unknown };
  return made;
});

/** What a model's or an aggregate's files say of its rules, and how the changed ones compare. */
export interface Inspected {
  /** Each rule the files write, by the name a report gives it, as the code that writes it. */
  readonly sources: ReadonlyMap<string, { readonly kind: string; readonly source: string }>;
  /** Each rule asked about, by name, against the text it was locked as. */
  readonly compared: ReadonlyMap<string, Comparison>;
}

/**
 * Read the rules of a model, or of one aggregate, from the files that declare
 * them, and compare each invariant in `changed` with the text it was locked as.
 */
export const inspect = Effect.fn(function* (options: {
  /** The file that declares the model or the aggregate. */
  readonly file: string;
  readonly target: unknown;
  readonly aggregates: ReadonlyArray<Aggregate.Any>;
  /** A model's decisions: each has transitions of its own. */
  readonly decisions?: ReadonlyArray<{ readonly decisionName: string; readonly command: unknown }>;
  /** A model's name, for the rules of its own. */
  readonly model?: string;
  /** Whether `sources` and `compared` are named `Rule` or `Aggregate.Rule`. */
  readonly qualified: boolean;
  /** For a rule that may have changed: the text it was locked as. */
  readonly locked: ReadonlyMap<string, string>;
  /** The functions not read, as for the verification itself. */
  readonly reading?: Source.Reading | undefined;
}) {
  const loader = yield* Source.loader(options.reading);
  loader.adopt(options.target);
  const modules = yield* Paths.reach(loader, options.file);
  const interpreter = Interpreter.make(loader, new Value.Run([]));
  const sources = new Map<string, { readonly kind: string; readonly source: string }>();
  const compared = new Map<string, Comparison>();
  const changed: Array<{
    readonly aggregate: Aggregate.Any;
    readonly definition: Paths.Definition;
    readonly rule: string;
    readonly name: string;
  }> = [];
  for (const aggregate of options.aggregates) {
    const definition = Paths.aggregateIn(modules, aggregate);
    if (!definition) continue;
    for (const key of ["invariants", "transitions"])
      for (const [rule, node] of Paths.written(definition, key)) {
        const name = options.qualified ? `${aggregate.aggregateName}.${rule}` : rule;
        const source = Paths.textOf(definition, node);
        sources.set(name, { kind: key === "invariants" ? "invariant" : "transition", source });
        const locked = options.locked.get(name);
        if (key === "invariants" && locked !== undefined && normal(locked) !== normal(source))
          changed.push({ aggregate, definition, rule, name });
      }
  }
  for (const decision of options.decisions ?? []) {
    const found = yield* Paths.decisionIn(interpreter, modules, decision);
    if (!found) continue;
    const definition: Paths.Definition = { ...found, state: undefined };
    for (const [rule, node] of Paths.written(definition, "transitions"))
      sources.set(`${decision.decisionName}.${rule}`, {
        kind: "transition",
        source: Paths.textOf(definition, node),
      });
  }
  if (options.model !== undefined) {
    const home = modules.find(
      (module) => Paths.find(module.program, options.model!, "aggregates") !== undefined,
    );
    const definition: Paths.Definition | undefined = home && {
      module: home,
      node: Paths.find(home.program, options.model, "aggregates")!,
      name: options.model,
      state: undefined,
    };
    if (definition) {
      for (const key of ["invariants", "eventually", "sometimes"])
        for (const [rule, node] of Paths.written(definition, key))
          sources.set(`${options.model}.${rule}`, {
            kind: key === "invariants" ? "model invariant" : key,
            source: Paths.textOf(definition, node),
          });
      for (const rule of Paths.relationNames(definition)) {
        const node = Paths.relationNode(definition, rule);
        if (node)
          sources.set(`${options.model}.${rule}`, {
            kind: "relation",
            source: Paths.textOf(definition, node),
          });
      }
    }
  }
  if (changed.length > 0) {
    const solver = yield* Smt.solver;
    for (const one of changed)
      compared.set(
        one.name,
        yield* compare(
          solver,
          loader,
          interpreter,
          one.aggregate,
          one.definition,
          one.rule,
          options.locked.get(one.name)!,
        ),
      );
  }
  const made: Inspected = { sources, compared };
  return made;
});
