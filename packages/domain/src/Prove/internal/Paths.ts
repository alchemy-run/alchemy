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
      /**
       * The parts of the new state that are not what they were, and have a
       * check the prover does not read: nothing says the new value passes it.
       */
      readonly unread: ReadonlyArray<Symbolic.Unread>;
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

/** An id as the solver's text: `undefined` for a value that is not one. */
export const addressOf = (id: V | undefined): string | undefined =>
  id?._tag === "Str" ? Smt.string(id.value).text : id?._tag === "Term" ? id.term.text : undefined;

/** The id of the instance a command is for, as the aggregate's `keyOf` reads it from the command. */
export const keyOf = (interpreter: Interpreter, definition: Definition, command: V): Eval<V> =>
  Effect.gen(function* () {
    const site = siteOf(definition);
    const node = property(definition, "keyOf");
    if (!node)
      return yield* Value.notTranslated(
        site,
        `${definition.name} has no keyOf, so the instance a command is for is not known`,
      );
    const read = yield* interpreter.evaluate(node, interpreter.moduleEnv(definition.module));
    return yield* strict(interpreter.call(read, [command], site), site, "keyOf");
  });

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
    const commandValue = on?.given ?? commandOf(command, label, run);
    // The command's input names its instance: the aggregate's `keyOf` reads it.
    const key = yield* keyOf(interpreter, definition, commandValue);
    const id: V = on?.id ?? key;
    const idText = addressOf(id);
    const keyText = addressOf(key);
    if (idText === undefined || keyText === undefined)
      return yield* Value.notTranslated(
        site,
        `${command.tag} is sent to something that is not an id`,
      );
    if (idText !== keyText) {
      if (id._tag === "Str" && key._tag === "Str") return yield* new Value.Infeasible();
      run.assume(`(= ${keyText} ${idText})`);
    }
    const { commandId, now } = stamp(label, run);
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

    const next = yield* folded(interpreter, definition, command.tag, state, events, {
      id,
      stream,
      version,
      now,
      commandId,
    });
    return { inputs, applied: { _tag: "Changed", events, state: next } } as const;
  });

/** A command with every field an input: any value its schema allows. */
const commandOf = (command: CommandClass, label: string, run: Value.Run): V => {
  const fields: Record<string, V> = { _tag: Value.str(command.tag) };
  for (const [key, schema] of Object.entries(command.fields)) {
    const ast = Symbolic.typeOf(schema);
    if (key !== "_tag" && ast) fields[key] = Symbolic.symbolic(ast, `${label}command.${key}`, run);
  }
  return Value.obj(fields, { kind: "Command", cls: command });
};

/** The id a command is sent with and the time it is handled at, as inputs. */
const stamp = (label: string, run: Value.Run): { readonly commandId: V; readonly now: V } => {
  const commandId: V = { _tag: "Term", term: run.constant(`${label}commandId`, "String") };
  const nowTerm = run.constant(`${label}now`, "Int");
  run.assume(`(>= ${nowTerm.text} 0)`);
  run.assume(`(<= ${nowTerm.text} ${LATEST})`);
  return { commandId, now: { _tag: "Time", millis: nowTerm } };
};

/** A state after events, each folded with the aggregate's `evolve`. */
const folded = (
  interpreter: Interpreter,
  definition: Definition,
  command: string,
  state: V,
  events: ReadonlyArray<V>,
  on: {
    readonly id: V;
    readonly stream: V;
    readonly version: V;
    readonly now: V;
    readonly commandId: V;
  },
): Eval<V> =>
  Effect.gen(function* () {
    const site = siteOf(definition);
    const evolve = yield* handlers(interpreter, definition, "evolve");
    let next = state;
    for (const [index, event] of events.entries()) {
      const tag =
        event._tag === "Obj" && event.brand?.kind === "Event" ? event.fields._tag : undefined;
      if (tag?._tag !== "Str")
        return yield* Value.notTranslated(
          site,
          `decide for ${command} returns something that is not an event`,
        );
      const fold = yield* interpreter.member(evolve, tag.value, site);
      if (fold._tag === "Undef")
        return yield* Value.notTranslated(site, `evolve has no handler for ${tag.value}`);
      const envelope = Value.obj({
        id: on.id,
        stream: on.stream,
        seq:
          on.version._tag === "Num"
            ? Value.num(on.version.value + index + 1)
            : on.version._tag === "Term"
              ? Value.term("Int", `(+ ${on.version.term.text} ${index + 1})`)
              : on.version,
        at: on.now,
        commandId: on.commandId,
        correlationId: on.commandId,
      });
      next = yield* strict(
        interpreter.call(fold, [next, event, envelope], site),
        site,
        `evolve for ${tag.value}`,
      );
    }
    return next;
  });

/** A decision's definition, as written: the object passed to `Domain.Decision`. */
export interface DecisionDefinition {
  readonly module: Module;
  readonly node: Node;
  /** The tag of the command it implements. */
  readonly name: string;
}

/** One instance a decision reads: its aggregate, and what is known of it before the decision. */
export interface Slot {
  readonly definition: Definition;
  readonly id: V;
  readonly state: V;
  readonly version: V;
}

/** What a decision recorded on one of the instances it read, and the state that leaves. */
export interface Part {
  /** The instance's place among the ones the decision read. */
  readonly slot: number;
  readonly before: V;
  readonly events: ReadonlyArray<V>;
  readonly state: V;
}

export type Decided =
  | { readonly _tag: "Rejected"; readonly rejection: V }
  /** The decision recorded nothing: every state is what it was. */
  | { readonly _tag: "Unchanged" }
  | {
      readonly _tag: "Changed";
      /** Every event, in the order `decide` recorded them. */
      readonly events: ReadonlyArray<V>;
      /** One part for each instance something was recorded on. */
      readonly parts: ReadonlyArray<Part>;
    };

export interface DecisionStep {
  readonly inputs: { readonly command: V; readonly commandId: V; readonly now: V };
  /** The instances read, in the order `keyOf` names them, each once. */
  readonly slots: ReadonlyArray<Slot>;
  /** For each name in `reads`: the place of its instance, or of each of its instances. */
  readonly names: Readonly<Record<string, number | ReadonlyArray<number>>>;
  readonly applied: Decided;
}

/**
 * Decide one command across the instances it names and fold what it records
 * on each, in the interpreter's current run. `slotOf` says which instance an
 * id is: two names can stand for the same one, and it then gets one state.
 */
export const decided = (
  interpreter: Interpreter,
  decision: DecisionDefinition,
  command: CommandClass,
  label: string,
  slotOf: (name: string, id: V) => Eval<{ readonly index: number; readonly slot: Slot }>,
  given?: V,
): Eval<DecisionStep> =>
  Effect.gen(function* () {
    const run = interpreter.current.run;
    const site: Site = { module: decision.module, node: decision.node };
    const env = interpreter.moduleEnv(decision.module);
    const part = (name: string): Node | undefined =>
      (decision.node.properties as ReadonlyArray<Node>).find(
        (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === name,
      )?.value;
    run.label = label;
    const commandValue = given ?? commandOf(command, label, run);
    const { commandId, now } = stamp(label, run);
    const inputs = { command: commandValue, commandId, now };

    const keyNode = part("keyOf");
    const decideNode = part("decide");
    if (!keyNode || !decideNode)
      return yield* Value.notTranslated(
        site,
        `the decision for ${command.tag} is not written with keyOf and decide`,
      );
    const keys = yield* strict(
      interpreter.call(yield* interpreter.evaluate(keyNode, env), [commandValue], site),
      site,
      "keyOf",
    );
    if (keys._tag !== "Obj")
      return yield* Value.notTranslated(site, `keyOf for ${command.tag} does not give an object`);

    const slots = new Map<number, Slot>();
    const reads = new Map<number, V>();
    const names: Record<string, number | ReadonlyArray<number>> = {};
    const seen: Record<string, V> = {};
    const one = Effect.fnUntraced(function* (name: string, id: V) {
      const text = addressOf(id);
      if (text === undefined)
        return yield* Value.notTranslated(
          site,
          `keyOf for ${command.tag} gives ${name} something that is not an id`,
        );
      const { index, slot } = yield* slotOf(name, id);
      if (!slots.has(index)) {
        slots.set(index, slot);
        reads.set(
          index,
          Value.obj({
            id: slot.id,
            stream: Value.term("String", `(str.++ "${slot.definition.name}/" ${text})`),
            state: slot.state,
            version: slot.version,
            record: {
              _tag: "Native",
              name: `${name}.record`,
              call: ([event]) =>
                Effect.succeed(
                  Value.obj({ event: event ?? Value.undef }, { kind: "Recorded", cls: index }),
                ),
            },
          }),
        );
      }
      return index;
    });
    for (const [name, key] of Object.entries(keys.fields)) {
      const ids = key._tag === "List" ? Symbolic.force(key, run) : key;
      if (ids._tag === "Arr") {
        const indices: Array<number> = [];
        for (const id of ids.items) indices.push(yield* one(name, id));
        names[name] = indices;
        seen[name] = { _tag: "Arr", items: indices.map((index) => reads.get(index)!) };
      } else {
        const index = yield* one(name, ids);
        names[name] = index;
        seen[name] = reads.get(index)!;
      }
    }
    const order = [...slots.keys()];
    const read = order.map((index) => slots.get(index)!);
    /** Places among the instances read, in the order they are given back. */
    const placed = (index: number) => order.indexOf(index);
    const namesPlaced = Object.fromEntries(
      Object.entries(names).map(([name, index]) => [
        name,
        typeof index === "number" ? placed(index) : index.map(placed),
      ]),
    );
    const done = (applied: Decided): DecisionStep => ({
      inputs,
      slots: read,
      names: namesPlaced,
      applied,
    });

    const decision_ = yield* interpreter
      .call(
        yield* interpreter.evaluate(decideNode, env),
        [Value.obj(seen), commandValue, Value.obj({ commandId, now })],
        site,
      )
      .pipe(
        Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
        Effect.catchTag("Rejected", (rejected) => Effect.succeed(rejected)),
      );
    if (decision_._tag === "Rejected")
      return done({ _tag: "Rejected", rejection: decision_.rejection });
    if (decision_._tag === "Obj" && decision_.brand?.kind === "Rejection")
      return done({ _tag: "Rejected", rejection: decision_ });
    const items = decision_._tag === "List" ? Symbolic.force(decision_, run) : decision_;
    if (items._tag !== "Arr")
      return yield* Value.notTranslated(
        site,
        `decide for ${command.tag} returns something that is not a list of recorded events`,
      );
    if (items.items.length === 0) return done({ _tag: "Unchanged" });

    const recorded = new Map<number, Array<V>>();
    const events: Array<V> = [];
    for (const item of items.items) {
      const index =
        item._tag === "Obj" && item.brand?.kind === "Recorded" ? (item.brand.cls as number) : -1;
      const event = item._tag === "Obj" ? item.fields.event : undefined;
      if (index < 0 || !event)
        return yield* Value.notTranslated(
          site,
          `decide for ${command.tag} returns an event it did not record on an instance it read`,
        );
      events.push(event);
      const list = recorded.get(index);
      if (list) list.push(event);
      else recorded.set(index, [event]);
    }
    const parts: Array<Part> = [];
    for (const index of order) {
      const made = recorded.get(index);
      if (!made) continue;
      const slot = slots.get(index)!;
      parts.push({
        slot: placed(index),
        before: slot.state,
        events: made,
        state: yield* folded(interpreter, slot.definition, command.tag, slot.state, made, {
          id: slot.id,
          stream: Value.term("String", `(str.++ "${slot.definition.name}/" ${addressOf(slot.id)})`),
          version: slot.version,
          now,
          commandId,
        }),
      });
    }
    return done({ _tag: "Changed", events, parts });
  });

/**
 * A decision's own transitions on the step it took, each as a formula: what
 * holds of every instance it read, before and after, together.
 */
export const decisionChecks = (
  interpreter: Interpreter,
  decision: DecisionDefinition,
  step: DecisionStep,
): Eval<ReadonlyArray<Check>> =>
  Effect.gen(function* () {
    if (step.applied._tag !== "Changed") return [];
    const applied = step.applied;
    const site: Site = { module: decision.module, node: decision.node };
    const node = (decision.node.properties as ReadonlyArray<Node>).find(
      (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === "transitions",
    )?.value;
    if (!node) return [];
    const rules = yield* interpreter.evaluate(node, interpreter.moduleEnv(decision.module));
    const after = (index: number): V =>
      applied.parts.find((part) => part.slot === index)?.state ?? step.slots[index]!.state;
    const states = (of: (index: number) => V): V =>
      Value.obj(
        Object.fromEntries(
          Object.entries(step.names).map(([name, index]): [string, V] => [
            name,
            typeof index === "number" ? of(index) : { _tag: "Arr", items: index.map(of) },
          ]),
        ),
      );
    const args = [
      Value.obj({
        before: states((index) => step.slots[index]!.state),
        after: states(after),
        command: step.inputs.command,
        events: { _tag: "Arr", items: [...applied.events] },
      }),
    ];
    const made: Array<Check> = [];
    for (const name of rules._tag === "Obj" ? Object.keys(rules.fields) : []) {
      const condition = yield* strict(
        interpreter
          .call(yield* interpreter.member(rules, name, site), args, site)
          .pipe(
            Effect.flatMap((value) =>
              value._tag === "Effect" ? value.run : Effect.succeed(value),
            ),
          ),
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

/** The names of the transitions a decision declares. */
export const decisionRuleNames = (decision: DecisionDefinition): ReadonlyArray<string> => {
  const node = (decision.node.properties as ReadonlyArray<Node>).find(
    (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === "transitions",
  )?.value;
  return node?.type === "ObjectExpression"
    ? (node.properties as ReadonlyArray<Node>).flatMap((p) =>
        p.type === "Property" && !p.computed ? [String(p.key.name ?? p.key.value)] : [],
      )
    : [];
};

/** The object a model's `relations` are declared in, where its file writes one. */
const relationsOf = (model: Definition): ReadonlyArray<Node> => {
  const node = property(model, "relations");
  return node?.type === "ObjectExpression"
    ? (node.properties as ReadonlyArray<Node>).filter((p) => p.type === "Property" && !p.computed)
    : [];
};

/** The `holds` of a relation, as its file writes it inside `Domain.Relation({ ... })`. */
const relationNode = (model: Definition, name: string): Node | undefined => {
  const listed = relationsOf(model).find((p) => String(p.key.name ?? p.key.value) === name)?.value;
  // A relation declared on its own in the model's file, and listed by name.
  const value =
    listed?.type === "Identifier"
      ? (model.module.program.body as ReadonlyArray<Node>)
          .flatMap((statement) => {
            const declaration =
              statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
            return declaration?.type === "VariableDeclaration"
              ? (declaration.declarations as ReadonlyArray<Node>)
              : [];
          })
          .find((declared) => declared.id?.name === listed.name)?.init
      : listed;
  const written =
    value?.type === "CallExpression" && value.arguments?.[0]?.type === "ObjectExpression"
      ? (value.arguments[0] as Node)
      : value?.type === "ObjectExpression"
        ? value
        : undefined;
  return (written?.properties as ReadonlyArray<Node> | undefined)?.find(
    (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === "holds",
  )?.value;
};

/** The names of the relations a model's file declares where the prover can read them. */
export const relationNames = (model: Definition): ReadonlyArray<string> =>
  relationsOf(model)
    .map((p) => String(p.key.name ?? p.key.value))
    .filter((name) => relationNode(model, name) !== undefined);

/** A relation on one instance for each of its names, as a formula. It may split the path. */
export const relationHolds = (
  interpreter: Interpreter,
  model: Definition,
  name: string,
  on: Readonly<Record<string, { readonly id: V; readonly state: V }>>,
): Eval<string> =>
  Effect.gen(function* () {
    const site = siteOf(model);
    const node = relationNode(model, name);
    if (!node) return yield* Value.notTranslated(site, `the relation ${name} is not written here`);
    const holds = yield* interpreter.evaluate(node, interpreter.moduleEnv(model.module));
    const args = [
      Value.obj(
        Object.fromEntries(
          Object.entries(on).map(([key, one]) => [
            key,
            Value.obj({ id: one.id, state: one.state }),
          ]),
        ),
      ),
    ];
    const value = yield* strict(interpreter.call(holds, args, site), site, name);
    return formula(yield* interpreter.truth(value, site));
  });

/**
 * Any state an aggregate's schema allows that satisfies each of its
 * invariants the prover can read: what a proof starts an instance from.
 */
export const assumed = (interpreter: Interpreter, definition: Definition, name: string): Eval<V> =>
  Effect.gen(function* () {
    const run = interpreter.current.run;
    const ast = Symbolic.typeOf(definition.state);
    if (!ast)
      return yield* Value.notTranslated(
        siteOf(definition),
        `the state of ${definition.name} is not a schema`,
      );
    const state = Symbolic.symbolic(ast, name, run);
    for (const check of yield* checks(interpreter, definition, state).pipe(
      Effect.catchTag("NotTranslated", () => Effect.succeed<ReadonlyArray<Check>>([])),
    )) {
      if (Result.isFailure(check.condition)) continue;
      if (check.condition.success === "false") return yield* new Value.Infeasible();
      run.assume(check.condition.success);
    }
    return state;
  });

/** A file and every file it imports, directly or not: the ones that load. */
export const reach = Effect.fn(function* (loader: Source.Loader, file: string) {
  const modules: Array<Module> = [];
  const seen = new Set([file]);
  const pending = [file];
  while (pending.length > 0) {
    const next = pending.shift()!;
    const module = yield* loader.load(next).pipe(
      // A file the first one does not need to load is one the prover does not read.
      Effect.catchTag("LoadError", (error) =>
        next === file ? Effect.fail(error) : Effect.succeed(undefined),
      ),
    );
    if (!module) continue;
    modules.push(module);
    for (const resolved of module.resolved.values())
      if (!seen.has(resolved)) {
        seen.add(resolved);
        pending.push(resolved);
      }
  }
  return modules;
});

/** An aggregate's definition, in whichever of the files declares it. */
export const aggregateIn = (
  modules: ReadonlyArray<Module>,
  aggregate: Aggregate.Any,
): Definition | undefined => {
  for (const module of modules) {
    if (!Object.values(module.exports).includes(aggregate)) continue;
    const node = find(module.program, aggregate.aggregateName, "evolve");
    if (node)
      return {
        module,
        node,
        name: aggregate.aggregateName,
        state: aggregate.definition.state,
      };
  }
  return undefined;
};

/**
 * A decision's definition, in whichever of the files declares it: the object
 * passed to `Domain.Decision` after the command it implements.
 */
export const decisionIn = Effect.fn(function* (
  interpreter: Interpreter,
  modules: ReadonlyArray<Module>,
  decision: { readonly decisionName: string; readonly command: unknown },
) {
  for (const module of modules) {
    if (!Object.values(module.exports).includes(decision)) continue;
    const calls: Array<Node> = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== "object" || node === null) return;
      const n = node as Node;
      if (
        n.type === "CallExpression" &&
        n.arguments?.[1]?.type === "ObjectExpression" &&
        ["reads", "keyOf", "decide"].every((key) =>
          (n.arguments[1].properties as ReadonlyArray<Node>).some(
            (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key,
          ),
        )
      )
        calls.push(n);
      for (const [key, value] of Object.entries(n))
        if (key !== "type" && typeof value === "object") visit(value);
    };
    visit(module.program);
    for (const call of calls) {
      const command = yield* interpreter
        .evaluate(call.arguments[0] as Node, interpreter.moduleEnv(module))
        .pipe(Effect.result);
      if (
        Result.isSuccess(command) &&
        command.success._tag === "Host" &&
        command.success.value === decision.command
      ) {
        const found: DecisionDefinition = {
          module,
          node: call.arguments[1] as Node,
          name: decision.decisionName,
        };
        return found;
      }
    }
  }
  return undefined;
});

export interface Check {
  readonly name: string;
  readonly condition: Result.Result<string, Value.NotTranslated>;
}

/** The step a command took, as a transition is given it. */
export interface Taken {
  readonly before: V;
  readonly command: V;
  readonly events: ReadonlyArray<V>;
}

/**
 * Every invariant on a state, as a formula, and with the step that left the
 * state, every transition on that step. Each may split the path. One named
 * in `proved` is not read again: it is true.
 */
export const checks = (
  interpreter: Interpreter,
  definition: Definition,
  state: V,
  taken?: Taken,
  proved?: ReadonlySet<string>,
  /** The property the rules are under: a model also has `eventually`. */
  key = "invariants",
): Eval<ReadonlyArray<Check>> =>
  Effect.gen(function* () {
    const site = siteOf(definition);
    const made: Array<Check> = [];
    const each = Effect.fnUntraced(function* (key: string, args: ReadonlyArray<V>) {
      const rules = yield* handlers(interpreter, definition, key);
      const names = rules._tag === "Obj" ? Object.keys(rules.fields) : [];
      for (const name of names) {
        if (proved?.has(name)) {
          made.push({ name, condition: Result.succeed("true") });
          continue;
        }
        const condition = yield* strict(
          interpreter
            .call(yield* interpreter.member(rules, name, site), args, site)
            .pipe(
              Effect.flatMap((value) =>
                value._tag === "Effect" ? value.run : Effect.succeed(value),
              ),
            ),
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
    });
    yield* each(key, [state]);
    if (taken)
      yield* each("transitions", [
        Value.obj({
          before: taken.before,
          after: state,
          command: taken.command,
          events: { _tag: "Arr", items: [...taken.events] },
        }),
      ]);
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
    const after = stepped.applied.state;
    return {
      _tag: "Changed",
      checks: yield* checks(interpreter, definition, stepped.applied.state, {
        before: state,
        command: stepped.inputs.command,
        events: stepped.applied.events,
      }),
      fits: Symbolic.fits(stepped.applied.state, stateAst, run),
      unread: Symbolic.unread(definition.state, "state").filter(
        (check) => !same(at(state, check.path), at(after, check.path)),
      ),
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

/** The part of a value a path of properties leads to. */
export const at = (value: V | undefined, path: ReadonlyArray<string>): V | undefined =>
  path.reduce<V | undefined>(
    (part, key) => (part?._tag === "Obj" ? part.fields[key] : undefined),
    value,
  );

/** Whether a part of the state is what it was: the same input, or the same value written again. */
export const same = (a: V | undefined, b: V | undefined): boolean => {
  if (a === b) return true;
  if (!a || !b || a._tag !== b._tag) return false;
  switch (a._tag) {
    case "Num":
    case "Big":
    case "Str":
    case "Bool":
      return a.value === (b as typeof a).value;
    case "Null":
    case "Undef":
      return true;
    case "Term":
      return a.term.text === (b as typeof a).term.text;
    case "Time":
      return a.millis.text === (b as typeof a).millis.text;
    case "List":
      return a.name === (b as typeof a).name;
    case "Obj": {
      const other = (b as typeof a).fields;
      const keys = Object.keys(a.fields);
      return (
        keys.length === Object.keys(other).length &&
        keys.every((key) => same(a.fields[key], other[key]))
      );
    }
    case "Arr": {
      const other = (b as typeof a).items;
      return a.items.length === other.length && a.items.every((item, i) => same(item, other[i]));
    }
    default:
      return false;
  }
};

/** The names under one of the definition's objects of rules, e.g. `invariants`. */
export const namesOf = (definition: Definition, key: string): ReadonlyArray<string> => {
  const node = property(definition, key);
  return node?.type === "ObjectExpression"
    ? (node.properties as ReadonlyArray<Node>).flatMap((p) =>
        p.type === "Property" && !p.computed ? [String(p.key.name ?? p.key.value)] : [],
      )
    : [];
};

/** The names of the invariants the definition declares. */
export const invariantNames = (definition: Definition): ReadonlyArray<string> =>
  namesOf(definition, "invariants");

/** The names of the transitions the definition declares. */
export const transitionNames = (definition: Definition): ReadonlyArray<string> =>
  namesOf(definition, "transitions");

/** The names of everything a command must keep: the invariants, then the transitions. */
export const ruleNames = (definition: Definition): ReadonlyArray<string> => [
  ...invariantNames(definition),
  ...transitionNames(definition),
];

/**
 * The invariants and transitions a class has that the definition read from
 * its file does not declare, and the names both use.
 */
export const unread = (
  definition: Definition,
  declared: {
    readonly invariants?: { readonly [name: string]: unknown } | undefined;
    readonly transitions?: { readonly [name: string]: unknown } | undefined;
  },
): ReadonlyArray<string> => {
  const invariants = new Set(invariantNames(definition));
  const transitions = new Set(transitionNames(definition));
  return [
    ...Object.keys(declared.invariants ?? {}).filter((name) => !invariants.has(name)),
    ...Object.keys(declared.transitions ?? {}).filter(
      (name) => !transitions.has(name) || invariants.has(name),
    ),
  ];
};

/**
 * The object passed to `Domain.Aggregate(name, { ... })`,
 * `Domain.Model(name, { ... })` or `Domain.View(name, { ... })` in a file: the
 * one with the property `key`, which an event or a command of the same name
 * does not have.
 */
export const find = (
  program: Node,
  name: string,
  /** `evolve` for an aggregate: one that only takes part in decisions has no `decide`. */
  key: "evolve" | "aggregates" | "from",
): Node | undefined => {
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
      n.arguments[1]?.type === "ObjectExpression" &&
      (n.arguments[1].properties as ReadonlyArray<Node>).some(
        (p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === key,
      )
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
    loader.adopt(aggregate);
    const module = yield* loader.load(file);
    const node = find(module.program, aggregate.aggregateName, "evolve");
    if (!node)
      return yield* new Source.LoadError({
        file,
        message: `${file} does not declare the aggregate ${aggregate.aggregateName}`,
      });
    const definition: Definition = {
      module,
      node,
      name: aggregate.aggregateName,
      state: aggregate.definition.state,
    };
    const missed = unread(definition, aggregate.definition);
    if (missed.length > 0)
      return yield* new Source.LoadError({
        file,
        message: `${file} declares ${aggregate.aggregateName} without its invariants ${missed.join(", ")}: each must be written in its definition, as a property, under a name of its own`,
      });
    return { loader, definition };
  });
