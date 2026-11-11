import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as FilePath from "effect/Path";
import * as Result from "effect/Result";
import type * as Aggregate from "../../Aggregate.ts";
import type { Interpreter } from "./Interpreter.ts";
import * as Smt from "./Smt.ts";
import * as Source from "./Source.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Eval, Module, Node, Site, V } from "./Value.ts";
import * as Value from "./Value.ts";

/** A command class, as far as the prover reads it. */
export interface CommandClass {
  readonly tag: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** The aggregate's definition, as written: the object passed to `Domain.Aggregate`. */
export interface Definition {
  readonly module: Module;
  readonly node: Node;
  readonly name: string;
  readonly state: unknown;
}

/** Every input of one command, as the symbolic values the code ran on. */
export interface Inputs {
  readonly state: V;
  readonly command: V;
  readonly id: V;
  readonly commandId: V;
  readonly version: V;
  readonly now: V;
}

export type Outcome =
  /** The command was rejected, or recorded nothing: the state is what it was. */
  | { readonly _tag: "Unchanged" }
  /** The state after the command's events, and each invariant on it as a formula. */
  | {
      readonly _tag: "Changed";
      readonly checks: ReadonlyArray<Check>;
      /** That the new state is one the state's schema allows, as a formula. */
      readonly fits: string;
    }
  | { readonly _tag: "Stopped"; readonly error: Value.NotTranslated }
  | { readonly _tag: "Infeasible" };

export interface Path {
  readonly run: Value.Run;
  readonly inputs: Inputs | undefined;
  readonly outcome: Outcome;
}

/** The latest time the prover considers: the start of the year 2100. */
const LATEST = 4_102_444_800_000;

const formula = (truth: boolean | string): string =>
  typeof truth === "boolean" ? String(truth) : truth;

/** The property of the definition with this name, e.g. `decide`. */
const property = (definition: Definition, name: string): Node | undefined =>
  (definition.node.properties as ReadonlyArray<Node>).find(
    (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === name,
  )?.value;

const siteOf = (definition: Definition): Site => ({
  module: definition.module,
  node: definition.node,
});

/** Outside `decide`, a failure is not a rejection: nothing the prover reads does that. */
const strict = <A>(eval_: Eval<A>, site: Site, what: string): Eval<A> =>
  eval_.pipe(
    Effect.catchTag("Rejected", () => Effect.fail(Value.notTranslated(site, `${what} fails`))),
  );

/** One of the definition's objects of functions: `decide`, `evolve` or `invariants`. */
export const handlers = (
  interpreter: Interpreter,
  definition: Definition,
  name: string,
): Eval<V> => {
  const node = property(definition, name);
  return node
    ? interpreter.evaluate(node, interpreter.moduleEnv(definition.module))
    : Effect.succeed(Value.obj({}));
};

/** What one command does to a state. */
export type Applied =
  | { readonly _tag: "Rejected"; readonly rejection: V }
  /** The command recorded nothing: the state is what it was. */
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Changed"; readonly events: ReadonlyArray<V>; readonly state: V };

export interface Step {
  readonly inputs: Inputs;
  readonly applied: Applied;
}

/**
 * Decide one command on a state and fold its events, in the interpreter's
 * current run. The command's fields, its time and the request contexts it
 * reads are fresh inputs, named after `label`.
 */
export const step = (
  interpreter: Interpreter,
  definition: Definition,
  command: CommandClass,
  state: V,
  version: V,
  label: string,
  /**
   * With several instances in one run: which one the command addresses, and
   * the command itself when other code built it.
   */
  on?: { readonly id: V; readonly given?: V },
): Eval<Step> =>
  Effect.gen(function* () {
    const run = interpreter.current.run;
    const site = siteOf(definition);
    run.label = label;
    const fields: Record<string, V> = { _tag: Value.str(command.tag) };
    if (!on?.given)
      for (const [key, schema] of Object.entries(command.fields)) {
        const ast = Symbolic.typeOf(schema);
        if (key !== "_tag" && ast)
          fields[key] = Symbolic.symbolic(ast, `${label}command.${key}`, run);
      }
    const commandValue = on?.given ?? Value.obj(fields, { kind: "Command", cls: command });
    const id: V = on?.id ?? { _tag: "Term", term: run.constant("id", "String") };
    const idText =
      id._tag === "Str" ? Smt.string(id.value).text : id._tag === "Term" ? id.term.text : undefined;
    if (idText === undefined)
      return yield* Value.notTranslated(
        site,
        `${command.tag} is sent to something that is not an id`,
      );
    const commandId: V = { _tag: "Term", term: run.constant(`${label}commandId`, "String") };
    const nowTerm = run.constant(`${label}now`, "Int");
    const now: V = { _tag: "Time", millis: nowTerm };
    run.assume(`(>= ${nowTerm.text} 0)`);
    run.assume(`(<= ${nowTerm.text} ${LATEST})`);
    const stream = Value.term("String", `(str.++ "${definition.name}/" ${idText})`);
    const inputs: Inputs = { state, command: commandValue, id, commandId, version, now };

    const decide = yield* interpreter.member(
      yield* handlers(interpreter, definition, "decide"),
      command.tag,
      site,
    );
    if (decide._tag === "Undef")
      return yield* Value.notTranslated(site, `decide has no handler for ${command.tag}`);
    const decision = yield* interpreter
      .call(decide, [state, commandValue, Value.obj({ id, now, commandId, stream, version })], site)
      .pipe(
        Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
        Effect.catchTag("Rejected", (rejected) => Effect.succeed(rejected)),
      );
    if (decision._tag === "Rejected")
      return { inputs, applied: { _tag: "Rejected", rejection: decision.rejection } } as const;
    if (decision._tag === "Obj" && decision.brand?.kind === "Rejection")
      return { inputs, applied: { _tag: "Rejected", rejection: decision } } as const;
    const events = decision._tag === "Arr" ? decision.items : [decision];
    if (events.length === 0) return { inputs, applied: { _tag: "Unchanged" } } as const;

    const evolve = yield* handlers(interpreter, definition, "evolve");
    let next = state;
    for (const [index, event] of events.entries()) {
      const tag =
        event._tag === "Obj" && event.brand?.kind === "Event" ? event.fields._tag : undefined;
      if (tag?._tag !== "Str")
        return yield* Value.notTranslated(
          site,
          `decide for ${command.tag} returns something that is not an event`,
        );
      const fold = yield* interpreter.member(evolve, tag.value, site);
      if (fold._tag === "Undef")
        return yield* Value.notTranslated(site, `evolve has no handler for ${tag.value}`);
      const envelope = Value.obj({
        id,
        stream,
        seq:
          version._tag === "Num"
            ? Value.num(version.value + index + 1)
            : version._tag === "Term"
              ? Value.term("Int", `(+ ${version.term.text} ${index + 1})`)
              : version,
        at: now,
        commandId,
        correlationId: commandId,
      });
      next = yield* strict(
        interpreter.call(fold, [next, event, envelope], site),
        site,
        `evolve for ${tag.value}`,
      );
    }
    return { inputs, applied: { _tag: "Changed", events, state: next } } as const;
  });

export interface Check {
  readonly name: string;
  readonly condition: Result.Result<string, Value.NotTranslated>;
}

/** Every invariant on a state, as a formula. Each may split the path. */
export const checks = (
  interpreter: Interpreter,
  definition: Definition,
  state: V,
): Eval<ReadonlyArray<Check>> =>
  Effect.gen(function* () {
    const site = siteOf(definition);
    const invariants = yield* handlers(interpreter, definition, "invariants");
    const names = invariants._tag === "Obj" ? Object.keys(invariants.fields) : [];
    const made: Array<Check> = [];
    for (const name of names) {
      const condition = yield* strict(
        interpreter.call(yield* interpreter.member(invariants, name, site), [state], site),
        site,
        name,
      ).pipe(
        Effect.flatMap((value) => interpreter.truth(value, site)),
        Effect.map(formula),
        Effect.result,
      );
      if (Result.isFailure(condition) && condition.failure._tag === "Infeasible")
        return yield* new Value.Infeasible();
      made.push({ name, condition: condition as Result.Result<string, Value.NotTranslated> });
    }
    return made;
  });

/**
 * Run one command along one path: assume every invariant on any state the
 * schema allows, decide the command, fold its events, and say what each
 * invariant is on the state that results.
 */
export const path = (
  interpreter: Interpreter,
  definition: Definition,
  command: CommandClass,
  prefix: ReadonlyArray<number>,
): Effect.Effect<Path> => {
  const run = new Value.Run(prefix);
  interpreter.current.run = run;
  const site = siteOf(definition);
  let inputs: Inputs | undefined;

  const body: Eval<Outcome> = Effect.gen(function* () {
    const stateAst = Symbolic.typeOf(definition.state);
    if (!stateAst) return yield* Value.notTranslated(site, "the state is not a schema");
    const state = Symbolic.symbolic(stateAst, "state", run);

    // Assume: the state the command meets satisfies every invariant.
    for (const check of yield* checks(interpreter, definition, state).pipe(
      Effect.catchTag("NotTranslated", () => Effect.succeed<ReadonlyArray<Check>>([])),
    )) {
      if (Result.isFailure(check.condition)) continue;
      if (check.condition.success === "false") return yield* new Value.Infeasible();
      run.assume(check.condition.success);
    }

    const versionTerm = run.constant("version", "Int");
    run.assume(`(>= ${versionTerm.text} 0)`);
    const stepped = yield* step(
      interpreter,
      definition,
      command,
      state,
      { _tag: "Term", term: versionTerm },
      "",
    );
    inputs = stepped.inputs;
    if (stepped.applied._tag !== "Changed") return { _tag: "Unchanged" } as const;
    return {
      _tag: "Changed",
      checks: yield* checks(interpreter, definition, stepped.applied.state),
      fits: Symbolic.fits(stepped.applied.state, stateAst),
    } as const;
  });

  return body.pipe(
    Effect.catchTags({
      Infeasible: () => Effect.succeed<Outcome>({ _tag: "Infeasible" }),
      NotTranslated: (error) => Effect.succeed<Outcome>({ _tag: "Stopped", error }),
      Rejected: () => Effect.succeed<Outcome>({ _tag: "Unchanged" }),
    }),
    Effect.map((outcome) => ({ run, inputs, outcome })),
  );
};

/** The names of the invariants the definition declares. */
export const invariantNames = (definition: Definition): ReadonlyArray<string> => {
  const node = property(definition, "invariants");
  return node?.type === "ObjectExpression"
    ? (node.properties as ReadonlyArray<Node>).flatMap((p) =>
        p.type === "Property" && !p.computed ? [String(p.key.name ?? p.key.value)] : [],
      )
    : [];
};

/** The object passed to `Domain.Aggregate(name, { ... })` in a file. */
export const find = (program: Node, name: string): Node | undefined => {
  const visit = (node: unknown): Node | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    if (typeof node !== "object" || node === null) return undefined;
    const n = node as Node;
    if (
      n.type === "CallExpression" &&
      n.arguments?.[0]?.type === "Literal" &&
      n.arguments[0].value === name &&
      n.arguments[1]?.type === "ObjectExpression"
    )
      return n.arguments[1] as Node;
    for (const [key, value] of Object.entries(n)) {
      if (key === "type" || typeof value !== "object") continue;
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  };
  return visit(program);
};

/** Read the file an aggregate is declared in: its definition, and a loader for what it imports. */
export const load = (
  aggregate: Aggregate.Any,
  source: URL | string,
): Effect.Effect<
  { readonly loader: Source.Loader; readonly definition: Definition },
  Source.LoadError,
  FileSystem.FileSystem | FilePath.Path
> =>
  Effect.gen(function* () {
    const path = yield* FilePath.Path;
    const file =
      typeof source === "string"
        ? path.resolve(source)
        : yield* path
            .fromFileUrl(source)
            .pipe(
              Effect.mapError(
                (error) => new Source.LoadError({ file: String(source), message: error.message }),
              ),
            );
    const loader = yield* Source.loader;
    const module = yield* loader.load(file);
    const node = find(module.program, aggregate.aggregateName);
    if (!node)
      return yield* new Source.LoadError({
        file,
        message: `${file} does not declare the aggregate ${aggregate.aggregateName}`,
      });
    return {
      loader,
      definition: {
        module,
        node,
        name: aggregate.aggregateName,
        state: aggregate.definition.state,
      },
    };
  });
