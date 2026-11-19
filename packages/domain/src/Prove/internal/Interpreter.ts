import * as Effect from "effect/Effect";
import * as Library from "./Library.ts";
import * as Smt from "./Smt.ts";
import type { Loader } from "./Source.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Brand, Env, Eval, Module, Node, Run, Scope, Site, V } from "./Value.ts";
import * as Value from "./Value.ts";

const KINDS = ["Event", "Rejection", "Command"] as const;

/** A domain class: an event, a rejection or a command. */
interface DomainClass {
  readonly kind: (typeof KINDS)[number];
  readonly tag: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const isDomainClass = (u: unknown): u is DomainClass =>
  typeof u === "function" &&
  (KINDS as ReadonlyArray<unknown>).includes((u as { kind?: unknown }).kind) &&
  typeof (u as { tag?: unknown }).tag === "string";

/** A request context: a tag with the schema of what it provides. */
interface ContextTag {
  readonly key: string;
  readonly schema: unknown;
}

const isContextTag = (u: unknown): u is ContextTag =>
  typeof u === "function" &&
  typeof (u as { key?: unknown }).key === "string" &&
  Symbolic.typeOf((u as { schema?: unknown }).schema) !== undefined;

const fromHost = (value: unknown, name: string): V =>
  typeof value === "number"
    ? Value.num(value)
    : typeof value === "string"
      ? Value.str(value)
      : typeof value === "boolean"
        ? Value.bool(value)
        : typeof value === "bigint"
          ? { _tag: "Big", value }
          : value === null
            ? Value.nil
            : value === undefined
              ? Value.undef
              : { _tag: "Host", value, name };

const child = (parent: Scope | undefined): Scope => ({ variables: new Map(), parent });

/** `true`/`false` when known, else the formula for "this value is truthy". */
const truth = (v: V): boolean | string | undefined => {
  switch (v._tag) {
    case "Num":
      return v.value !== 0 && !Number.isNaN(v.value);
    case "Big":
      return v.value !== 0n;
    case "Str":
      return v.value !== "";
    case "Bool":
      return v.value;
    case "Null":
    case "Undef":
      return false;
    case "Term":
      return v.term.sort === "Bool"
        ? v.term.text
        : v.term.sort === "String"
          ? `(not (= ${v.term.text} ""))`
          : `(not (= ${v.term.text} ${v.term.sort === "Int" ? "0" : "0.0"}))`;
    case "Opaque":
      return undefined;
    default:
      return true;
  }
};

const fromTruth = (t: boolean | string): V =>
  typeof t === "boolean"
    ? Value.bool(t)
    : t === "true" || t === "false"
      ? Value.bool(t === "true")
      : Value.term("Bool", t);

const textual = (v: V): Smt.Term | undefined =>
  v._tag === "Str"
    ? Smt.string(v.value)
    : v._tag === "Term" && v.term.sort === "String"
      ? v.term
      : undefined;

const isPrimitive = (v: V): boolean =>
  v._tag === "Num" ||
  v._tag === "Big" ||
  v._tag === "Str" ||
  v._tag === "Bool" ||
  v._tag === "Null" ||
  v._tag === "Undef";

const isQuotient = (v: V): boolean => v._tag === "Term" && v.quotient !== undefined;

/** `a === b`: known, a formula, or `undefined` when the prover cannot tell. */
const same = (a: V, b: V): boolean | string | undefined => {
  if (a._tag === "Opaque" || b._tag === "Opaque" || a._tag === "Time" || b._tag === "Time")
    return a === b ? true : undefined;
  if (isPrimitive(a) && isPrimitive(b))
    return (
      a._tag === b._tag && (a as { value?: unknown }).value === (b as { value?: unknown }).value
    );
  const x = Library.numeric(a);
  const y = Library.numeric(b);
  if (x && y) {
    // A `bigint` is never a `number`, whatever the two count.
    if (Value.isBig(a) !== Value.isBig(b)) return false;
    // JavaScript rounds a division: it is the whole number it looks like only when it is one.
    if ((isQuotient(a) && y.sort !== "Int") || (isQuotient(b) && x.sort !== "Int"))
      return undefined;
    const [l, r] = Library.promote(x, y);
    // The same term on both sides is equal whatever it stands for.
    return l.text === r.text ? true : `(= ${l.text} ${r.text})`;
  }
  const s = textual(a);
  const t = textual(b);
  if (s && t) return `(= ${s.text} ${t.text})`;
  const p =
    a._tag === "Bool"
      ? Smt.bool(a.value)
      : a._tag === "Term" && a.term.sort === "Bool"
        ? a.term
        : undefined;
  const q =
    b._tag === "Bool"
      ? Smt.bool(b.value)
      : b._tag === "Term" && b.term.sort === "Bool"
        ? b.term
        : undefined;
  if (p && q) return `(= ${p.text} ${q.text})`;
  // Different kinds are never equal; objects and functions are equal only to themselves.
  return a === b;
};

export interface Interpreter {
  /** The run the interpreter records choices and assumptions in. */
  readonly current: { run: Run };
  readonly evaluate: (node: Node, env: Env) => Eval<V>;
  readonly call: (fn: V, args: ReadonlyArray<V>, site: Site) => Eval<V>;
  /** The result of `yield*` on a value: an effect's result, or a request context's value. */
  readonly settle: (value: V, site: Site) => Eval<V>;
  readonly member: (value: V, key: string, site: Site) => Eval<V>;
  /** Whether a value is truthy on this path. A symbolic value splits the path. */
  readonly decide: (value: V, site: Site) => Eval<boolean>;
  /** The formula for "this value is truthy", without splitting the path. */
  readonly truth: (value: V, site: Site) => Eval<boolean | string>;
  readonly moduleEnv: (module: Module) => Env;
  /** What a model explorer plugs in. */
  readonly hooks: Hooks;
}

export interface Hooks {
  /**
   * What `yield*` on a class gives, for the classes the caller knows: an
   * aggregate's client, a saga's, an external system's.
   */
  service: ((host: unknown, site: Site) => V | undefined) | undefined;
  /** What calling a function the prover does not read gives, for the functions the caller knows. */
  host: ((value: unknown, args: ReadonlyArray<V>, site: Site) => Eval<V> | undefined) | undefined;
  /** The request contexts provided around the code being run, by tag. */
  readonly provided: Map<unknown, V>;
  /** Models of library functions the caller adds, by `module:path`. */
  readonly models: Map<string, Library.Model>;
}

/** Leaves the `switch` or the loop it is in. */
const BREAK: V = { _tag: "Opaque", what: "break" };
/** Goes on to the next turn of the loop it is in. */
const CONTINUE: V = { _tag: "Opaque", what: "continue" };

/** The most turns a loop takes before the prover stops reading it. */
const MAX_TURNS = 10_000;

/** What `typeof` gives, for the values it is known of. */
const kindOf = (v: V): string | undefined => {
  switch (v._tag) {
    case "Num":
      return "number";
    case "Big":
      return "bigint";
    case "Str":
      return "string";
    case "Bool":
      return "boolean";
    case "Undef":
      return "undefined";
    case "Null":
    case "Obj":
    case "Arr":
    case "List":
    case "Time":
      return "object";
    case "Fn":
    case "Native":
      return "function";
    case "Term":
      return v.big
        ? "bigint"
        : v.term.sort === "String"
          ? "string"
          : v.term.sort === "Bool"
            ? "boolean"
            : "number";
    default:
      return undefined;
  }
};

/**
 * Runs the TypeScript of `decide`, `evolve` and the invariants on symbolic
 * values. It follows calls into the code the model is written in, uses a
 * model for each library function it knows, and stops with `NotTranslated`
 * at anything else.
 */
export const make = (loader: Loader, run: Run): Interpreter => {
  const current = { run };
  const hooks: Hooks = {
    service: undefined,
    host: undefined,
    provided: new Map(),
    models: new Map(),
  };
  const tops = new Map<string, V>();
  const roots = new Map<Module, Env>();
  /**
   * The calls being run, innermost last. `0` stands for a file's own
   * constants, which belong to no call.
   */
  const frames: Array<number> = [];
  let calls = 0;
  /** The call that made each array and object the code wrote. */
  const makers = new WeakMap<object, number>();

  /** An array or object the code wrote, remembered as the running call's. */
  const made = <A extends V>(value: A): A => {
    const frame = frames[frames.length - 1];
    if (frame !== undefined && frame !== 0) makers.set(value, frame);
    return value;
  };

  /**
   * Whether the code may change a value in place: it wrote the value itself,
   * in a call that has not returned. Anything else was given to it, and code
   * that changes what it is given is not a function of its inputs.
   */
  const mine = (value: V): boolean => {
    const frame = makers.get(value);
    return frame !== undefined && frames.includes(frame);
  };

  /** A list with its items, on this path. */
  const forced = (value: V): V =>
    value._tag === "List" ? Symbolic.force(value, current.run) : value;

  const moduleEnv = (module: Module): Env => {
    const known = roots.get(module);
    if (known) return known;
    const env: Env = { scope: child(undefined), module };
    roots.set(module, env);
    return env;
  };

  const fail = (site: Site, reason: string) => Effect.fail(Value.notTranslated(site, reason));

  const loadAt = (file: string, site: Site): Eval<Module> =>
    loader.load(file).pipe(Effect.mapError((error) => Value.notTranslated(site, error.message)));

  /** A top-level name of a module: a declaration, an import, or a runtime export. */
  const top: (module: Module, name: string, site: Site) => Eval<V | undefined> = Effect.fnUntraced(
    function* (module: Module, name: string, site: Site) {
      const key = `${module.path}#${name}`;
      const known = tops.get(key);
      if (known) return known;
      const resolved = yield* resolveTop(module, name, site);
      if (resolved) tops.set(key, resolved);
      return resolved;
    },
  );

  const resolveTop: (module: Module, name: string, site: Site) => Eval<V | undefined> =
    Effect.fnUntraced(function* (module: Module, name: string, site: Site) {
      const declaration = module.declarations.get(name);
      if (declaration?._tag === "Const") {
        if (!declaration.init) return Value.undef;
        // A constant the prover cannot build from its source, such as a schema, is the value Node loaded.
        frames.push(0);
        return yield* evaluate(declaration.init, moduleEnv(module)).pipe(
          Effect.ensuring(Effect.sync(() => void frames.pop())),
          Effect.map((made) =>
            made._tag === "Opaque" && name in module.exports
              ? fromHost(module.exports[name], name)
              : made,
          ),
          Effect.catchTag("NotTranslated", (error) =>
            name in module.exports
              ? Effect.succeed(fromHost(module.exports[name], name))
              : Effect.fail(error),
          ),
        );
      }
      if (declaration?._tag === "Function") {
        return {
          _tag: "Fn",
          node: declaration.node,
          env: moduleEnv(module),
          effectful: false,
        } as V;
      }
      if (declaration?._tag === "Class") {
        return name in module.exports
          ? fromHost(module.exports[name], name)
          : yield* fail(site, `${name} is a class that its file does not export`);
      }
      const imported = module.imports.get(name);
      if (imported) {
        const file = module.resolved.get(imported.specifier);
        if (file === undefined) {
          // A package: `import { Effect } from "effect"` is the module `effect/Effect`.
          return imported.imported === "*"
            ? ({ _tag: "Lib", module: imported.specifier, path: [] } as V)
            : imported.specifier === "effect"
              ? ({ _tag: "Lib", module: `effect/${imported.imported}`, path: [] } as V)
              : ({ _tag: "Lib", module: imported.specifier, path: [imported.imported] } as V);
        }
        const other = yield* loadAt(file, site);
        if (imported.imported === "*") return { _tag: "Namespace", module: other } as V;
        const found = yield* top(other, imported.imported, site);
        if (found) return found;
        return imported.imported in other.exports
          ? fromHost(other.exports[imported.imported], imported.imported)
          : yield* fail(site, `${name} is not exported by ${file}`);
      }
      for (const specifier of module.stars) {
        const file = module.resolved.get(specifier);
        if (file === undefined) continue;
        const found = yield* top(yield* loadAt(file, site), name, site);
        if (found) return found;
      }
      return undefined;
    });

  const lookup: (name: string, env: Env, site: Site) => Eval<V> = Effect.fnUntraced(function* (
    name: string,
    env: Env,
    site: Site,
  ) {
    for (let scope: Scope | undefined = env.scope; scope; scope = scope.parent) {
      const local = scope.variables.get(name);
      if (local) return local;
    }
    const found = yield* top(env.module, name, site);
    if (found) return found;
    if (name === "undefined") return Value.undef;
    if (name === "Math" || name === "Object") return { _tag: "Lib", module: name, path: [] } as V;
    if (name === "BigInt")
      return {
        _tag: "Native",
        name,
        call: ([value], at) =>
          value?._tag === "Big" || (value?._tag === "Term" && value.big)
            ? Effect.succeed(value)
            : value?._tag === "Num" && Number.isInteger(value.value)
              ? Effect.succeed<V>({ _tag: "Big", value: BigInt(value.value) })
              : value?._tag === "Term" && value.term.sort === "Int"
                ? Effect.succeed<V>({ _tag: "Term", term: value.term, big: true })
                : fail(at, "calls BigInt on a value the prover cannot see as a whole number"),
      } as V;
    return yield* fail(site, `refers to ${name}, which the prover cannot find`);
  });

  const library = Library.make({
    current,
    provided: hooks.provided,
    extra: hooks.models,
    call: (fn, args, site) => call(fn, args, site),
    settle: (value, site) => settle(value, site),
    decide: (value, site) => decide(value, site),
    equal: (a, b, site) => {
      const equal = same(a, b);
      return equal === undefined
        ? fail(site, "compares values the prover does not model")
        : Effect.succeed(fromTruth(equal));
    },
    force: (value) => forced(value),
    array: (name, items, fn, initial, site) => arrayMethods[name]!(items, fn, initial, site),
  });

  /** The array methods that take a function. The items are known; what the function gives may not be. */
  const arrayMethods: Record<
    string,
    (items: ReadonlyArray<V>, fn: V, initial: V | undefined, at: Site) => Eval<V>
  > = {
    find: Effect.fnUntraced(function* (items, fn, _initial, at) {
      for (const item of items) if (yield* decide(yield* call(fn, [item], at), at)) return item;
      return Value.undef;
    }),
    filter: Effect.fnUntraced(function* (items, fn, _initial, at) {
      const kept: Array<V> = [];
      for (const [index, item] of items.entries())
        if (yield* decide(yield* call(fn, [item, Value.num(index)], at), at)) kept.push(item);
      return { _tag: "Arr", items: kept } as V;
    }),
    map: Effect.fnUntraced(function* (items, fn, _initial, at) {
      const made: Array<V> = [];
      for (const [index, item] of items.entries())
        made.push(yield* call(fn, [item, Value.num(index)], at));
      return { _tag: "Arr", items: made } as V;
    }),
    flatMap: Effect.fnUntraced(function* (items, fn, _initial, at) {
      const made: Array<V> = [];
      for (const [index, item] of items.entries()) {
        const given = yield* call(fn, [item, Value.num(index)], at);
        if (given._tag === "Arr") made.push(...given.items);
        else made.push(given);
      }
      return { _tag: "Arr", items: made } as V;
    }),
    // `every` and `some` give one formula over all the items, so a rule over a list does not split the path.
    every: Effect.fnUntraced(function* (items, fn, _initial, at) {
      const parts: Array<string> = [];
      for (const [index, item] of items.entries()) {
        const t = yield* truthOf(yield* call(fn, [item, Value.num(index)], at), at);
        if (t === false || t === "false") return Value.bool(false);
        if (t !== true && t !== "true") parts.push(t);
      }
      return fromTruth(
        parts.length === 0 ? true : parts.length === 1 ? parts[0]! : `(and ${parts.join(" ")})`,
      );
    }),
    some: Effect.fnUntraced(function* (items, fn, _initial, at) {
      const parts: Array<string> = [];
      for (const [index, item] of items.entries()) {
        const t = yield* truthOf(yield* call(fn, [item, Value.num(index)], at), at);
        if (t === true || t === "true") return Value.bool(true);
        if (t !== false && t !== "false") parts.push(t);
      }
      return fromTruth(
        parts.length === 0 ? false : parts.length === 1 ? parts[0]! : `(or ${parts.join(" ")})`,
      );
    }),
    findIndex: Effect.fnUntraced(function* (items, fn, _initial, at) {
      for (const [index, item] of items.entries())
        if (yield* decide(yield* call(fn, [item, Value.num(index)], at), at))
          return Value.num(index);
      return Value.num(-1);
    }),
    forEach: Effect.fnUntraced(function* (items, fn, _initial, at) {
      for (const [index, item] of [...items].entries())
        yield* call(fn, [item, Value.num(index)], at);
      return Value.undef;
    }),
    reduce: Effect.fnUntraced(function* (items, fn, initial, at) {
      if (initial === undefined && items.length === 0)
        return yield* fail(at, "reduces an empty array with no first value");
      let total = initial ?? items[0]!;
      for (const [index, item] of items.entries()) {
        if (initial === undefined && index === 0) continue;
        total = yield* call(fn, [total, item, Value.num(index)], at);
      }
      return total;
    }),
  };

  /** The array methods that take values. */
  const arrayOwn: Record<
    string,
    (self: V & { readonly _tag: "Arr" }, args: ReadonlyArray<V>, at: Site) => Eval<V>
  > = {
    includes: (self, [wanted], at) => {
      const parts: Array<string> = [];
      for (const item of self.items) {
        const equal = same(item, wanted ?? Value.undef);
        if (equal === undefined) return fail(at, "looks for a value the prover does not model");
        if (equal === true) return Effect.succeed(Value.bool(true));
        if (equal !== false) parts.push(equal);
      }
      return Effect.succeed(
        fromTruth(
          parts.length === 0 ? false : parts.length === 1 ? parts[0]! : `(or ${parts.join(" ")})`,
        ),
      );
    },
    concat: (self, args, at) => {
      const items = [...self.items];
      for (const argument of args.map(forced)) {
        if (argument._tag === "Arr") items.push(...argument.items);
        else if (argument._tag === "Opaque") return fail(at, `joins ${argument.what} to an array`);
        else items.push(argument);
      }
      return Effect.succeed(made<V>({ _tag: "Arr", items }));
    },
    slice: (self, [from, to], at) =>
      (from === undefined || from._tag === "Num" || from._tag === "Undef") &&
      (to === undefined || to._tag === "Num" || to._tag === "Undef")
        ? Effect.succeed(
            made<V>({
              _tag: "Arr",
              items: self.items.slice(
                from?._tag === "Num" ? from.value : undefined,
                to?._tag === "Num" ? to.value : undefined,
              ),
            }),
          )
        : fail(at, "slices an array at a place the prover cannot see"),
    at: (self, [index], at) =>
      index?._tag === "Num"
        ? Effect.succeed(self.items.at(index.value) ?? Value.undef)
        : fail(at, "reads an array at a place the prover cannot see"),
    entries: (self) =>
      Effect.succeed<V>({
        _tag: "Arr",
        items: self.items.map((item, index): V => ({
          _tag: "Arr",
          items: [Value.num(index), item],
        })),
      }),
    keys: (self) =>
      Effect.succeed<V>({ _tag: "Arr", items: self.items.map((_, index) => Value.num(index)) }),
    values: (self) => Effect.succeed<V>({ _tag: "Arr", items: [...self.items] }),
    push: (self, args, at) => {
      if (!mine(self)) return fail(at, "pushes onto an array it was given, which changes it");
      (self.items as Array<V>).push(...args);
      return Effect.succeed(Value.num(self.items.length));
    },
  };

  const member: Interpreter["member"] = Effect.fnUntraced(function* (
    value: V,
    key: string,
    site: Site,
  ) {
    switch (value._tag) {
      case "Obj":
        // `option.pipe(Option.map(f))`: each function applied to what the one before gave.
        if (
          key === "pipe" &&
          (value.brand?.kind === "Option" || value.brand?.kind === "Matcher") &&
          !value.fields.pipe
        )
          return {
            _tag: "Native",
            name: "pipe",
            call: Effect.fnUntraced(function* (steps: ReadonlyArray<V>, at: Site) {
              let piped: V = value;
              for (const step of steps) piped = yield* call(step, [piped], at);
              return piped;
            }),
          };
        return value.fields[key] ?? Value.undef;
      case "List":
        return yield* member(forced(value), key, site);
      case "Arr":
        if (key === "length") return Value.num(value.items.length);
        if (Object.hasOwn(arrayOwn, key)) {
          const method = arrayOwn[key]!;
          return {
            _tag: "Native",
            name: key,
            call: (args: ReadonlyArray<V>, at: Site) => method(value, args, at),
          };
        }
        if (Object.hasOwn(arrayMethods, key)) {
          const method = arrayMethods[key]!;
          return {
            _tag: "Native",
            name: key,
            call: Effect.fnUntraced(function* (args: ReadonlyArray<V>, at: Site) {
              const fn = args[0];
              if (!fn) return yield* fail(at, `calls ${key} without a function`);
              return yield* method(value.items, fn, args[1], at);
            }),
          };
        }
        return /^\d+$/.test(key)
          ? (value.items[Number(key)] ?? Value.undef)
          : yield* fail(site, `reads .${key} of an array`);
      case "Str":
        return key === "length"
          ? Value.num(value.value.length)
          : yield* fail(site, `reads .${key} of a string`);
      case "Term":
        return value.term.sort === "String" && key === "length"
          ? Value.term("Int", `(str.len ${value.term.text})`)
          : yield* fail(site, `reads .${key} of a ${value.term.sort.toLowerCase()}`);
      case "Optic":
        return (
          library.opticMember(value, key) ??
          (yield* fail(site, `uses an optic's .${key}, which the prover has no model for`))
        );
      case "Lib": {
        const next: V & { readonly _tag: "Lib" } = { ...value, path: [...value.path, key] };
        return library.valueOf(next) ?? next;
      }
      case "Namespace": {
        const found = yield* top(value.module, key, site);
        return found ?? fromHost(value.module.exports[key], key);
      }
      case "Host":
        // `AccountId.make(text)`: the text, when the schema allows it.
        if (key === "make" && Symbolic.typeOf(value.value) !== undefined) {
          const ast = Symbolic.typeOf(value.value)!;
          return {
            _tag: "Native",
            name: `${value.name}.make`,
            call: ([made]) =>
              made && Symbolic.assumeFits(made, ast, current.run)
                ? Effect.succeed(made)
                : Effect.fail(new Value.Infeasible()),
          };
        }
        return fromHost((value.value as Record<string, unknown>)[key], `${value.name}.${key}`);
      case "Effect":
        // `effect.pipe(f, g)`: each function applied to what the one before gave.
        if (key === "pipe")
          return {
            _tag: "Native",
            name: "pipe",
            call: Effect.fnUntraced(function* (steps: ReadonlyArray<V>, at: Site) {
              let piped: V = value;
              for (const step of steps) piped = yield* call(step, [piped], at);
              return piped;
            }),
          };
        return yield* fail(site, `reads .${key} of an effect`);
      case "Opaque":
        return yield* fail(site, `reads .${key} of ${value.what}, which the prover does not model`);
      default:
        return yield* fail(
          site,
          `reads .${key} of ${value._tag === "Null" ? "null" : value._tag === "Undef" ? "undefined" : `a ${value._tag}`}`,
        );
    }
  });

  const truthOf: Interpreter["truth"] = (value, site) => {
    const t = truth(value);
    return t === undefined
      ? fail(site, "tests a value the prover does not model")
      : Effect.succeed(t);
  };

  const decide: Interpreter["decide"] = (value, site) =>
    truthOf(value, site).pipe(
      Effect.map((t) => (typeof t === "boolean" ? t : current.run.branch(t))),
    );

  const bind: (pattern: Node, value: V, scope: Scope, env: Env) => Eval<void> = Effect.fnUntraced(
    function* (pattern: Node, value: V, scope: Scope, env: Env) {
      const site: Site = { module: env.module, node: pattern };
      switch (pattern.type) {
        case "Identifier":
          scope.variables.set(pattern.name, value);
          return;
        case "AssignmentPattern":
          return yield* bind(
            pattern.left,
            value._tag === "Undef" ? yield* evaluate(pattern.right, { ...env, scope }) : value,
            scope,
            env,
          );
        case "ObjectPattern": {
          const taken: Array<string> = [];
          for (const property of pattern.properties as ReadonlyArray<Node>) {
            if (property.type === "RestElement") {
              // `{ a, ...rest }`: what is left of an object whose keys the prover sees.
              if (value._tag !== "Obj")
                return yield* fail(site, "takes the rest of a value the prover cannot see into");
              yield* bind(
                property.argument,
                made(
                  Value.obj(
                    Object.fromEntries(
                      Object.entries(value.fields).filter(([key]) => !taken.includes(key)),
                    ),
                  ),
                ),
                scope,
                env,
              );
              continue;
            }
            if (property.type !== "Property")
              return yield* fail(site, "destructures in a way the prover does not read");
            const named = property.computed
              ? yield* evaluate(property.key, { ...env, scope })
              : Value.str(
                  property.key.type === "Identifier"
                    ? property.key.name
                    : String(property.key.value),
                );
            if (named._tag !== "Str" && named._tag !== "Num")
              return yield* fail(site, "destructures by a key the prover cannot see");
            const key = String(named.value);
            taken.push(key);
            yield* bind(property.value, yield* member(value, key, site), scope, env);
          }
          return;
        }
        case "ArrayPattern": {
          const list = forced(value);
          for (const [index, element] of (
            pattern.elements as ReadonlyArray<Node | null>
          ).entries()) {
            if (!element) continue;
            if (element.type === "RestElement") {
              if (list._tag !== "Arr")
                return yield* fail(site, "takes the rest of a value that is not a known array");
              yield* bind(
                element.argument,
                made<V>({ _tag: "Arr", items: list.items.slice(index) }),
                scope,
                env,
              );
              continue;
            }
            yield* bind(element, yield* member(list, String(index), site), scope, env);
          }
          return;
        }
        default:
          return yield* fail(site, `binds a ${pattern.type}, which the prover does not read`);
      }
    },
  );

  /** Run a function's body with its parameters bound. */
  const invoke: (fn: V & { readonly _tag: "Fn" }, args: ReadonlyArray<V>) => Eval<V> =
    Effect.fnUntraced(function* (fn: V & { readonly _tag: "Fn" }, args: ReadonlyArray<V>) {
      const scope = child(fn.env.scope);
      const env: Env = { module: fn.env.module, scope };
      for (const [index, parameter] of (fn.node.params as ReadonlyArray<Node>).entries()) {
        if (parameter.type === "RestElement")
          yield* bind(parameter.argument, { _tag: "Arr", items: args.slice(index) }, scope, env);
        else yield* bind(parameter, args[index] ?? Value.undef, scope, env);
      }
      const body: Node = fn.node.body;
      // What the call writes, it may change until it returns.
      const frame = ++calls;
      frames.push(frame);
      const leave = Effect.sync(() => void frames.splice(frames.lastIndexOf(frame), 1));
      if (body.type !== "BlockStatement")
        return yield* evaluate(body, env).pipe(Effect.ensuring(leave));
      const returned = yield* execute(body.body, env).pipe(Effect.ensuring(leave));
      return returned === undefined || returned === BREAK || returned === CONTINUE
        ? Value.undef
        : returned;
    });

  /** Write a property of a value the code made itself. */
  const write = (object: V, key: V, value: V, site: Site): Eval<void> => {
    if (key._tag !== "Str" && key._tag !== "Num")
      return fail(site, "writes a property by a key the prover cannot see");
    if ((object._tag !== "Obj" && object._tag !== "Arr") || !mine(object))
      return fail(
        site,
        "changes a value it was given: the prover reads code that changes only what it wrote itself",
      );
    if (object._tag === "Obj") (object.fields as Record<string, V>)[String(key.value)] = value;
    else if (typeof key.value === "number" && Number.isInteger(key.value) && key.value >= 0)
      (object.items as Array<V>)[key.value] = value;
    else return fail(site, "writes an array at a place that is not an index");
    return Effect.void;
  };

  /** Give a variable or a property a new value. */
  const assign: (target: Node, value: V, env: Env, site: Site) => Eval<void> = Effect.fnUntraced(
    function* (target: Node, value: V, env: Env, site: Site) {
      if (target.type === "Identifier") {
        for (let scope: Scope | undefined = env.scope; scope; scope = scope.parent) {
          if (scope.variables.has(target.name)) {
            scope.variables.set(target.name, value);
            return;
          }
        }
        return yield* fail(site, `assigns to ${target.name}, which is not a local variable`);
      }
      if (target.type !== "MemberExpression")
        return yield* fail(site, "assigns in a way the prover does not read");
      const object = yield* evaluate(target.object, env);
      const key = target.computed
        ? yield* evaluate(target.property, env)
        : Value.str(target.property.name);
      return yield* write(object, key, value, site);
    },
  );

  /** One turn of a loop: `BREAK` to leave it, a value to return, or nothing to go on. */
  const turn = (body: Node, env: Env): Eval<V | undefined> =>
    execute([body], env).pipe(
      Effect.map((returned) => (returned === CONTINUE ? undefined : returned)),
    );

  /** Whether a loop goes on. What an input decides, the prover cannot count the turns of. */
  const goesOn: (test: Node | null, env: Env, site: Site) => Eval<boolean> = Effect.fnUntraced(
    function* (test: Node | null, env: Env, site: Site) {
      if (!test) return true;
      const t = yield* truthOf(yield* evaluate(test, env), site);
      if (t === true || t === "true") return true;
      if (t === false || t === "false") return false;
      return yield* fail(site, "loops a number of times that depends on an input");
    },
  );

  const call: Interpreter["call"] = (fn, args, site) => {
    switch (fn._tag) {
      case "Fn":
        if (fn.node.async) return fail(site, "calls an async function");
        // A generator's body runs when it is yielded, as an effect does.
        return fn.node.generator || fn.effectful
          ? Effect.succeed<V>({ _tag: "Effect", run: Effect.suspend(() => invoke(fn, args)) })
          : invoke(fn, args);
      case "Native":
        return fn.call(args, site);
      case "Lib":
        return library.call(fn, args, site);
      case "Host":
        return (
          hooks.host?.(fn.value, args, site) ??
          fail(site, `calls ${fn.name}, which is outside the code the prover reads`)
        );
      case "Opaque":
        return fail(site, `calls ${fn.what}, which the prover does not model`);
      default:
        return fail(site, "calls something that is not a function");
    }
  };

  const settle: Interpreter["settle"] = (value, site) => {
    if (value._tag === "Effect") return value.run;
    if (value._tag === "Obj" && value.brand?.kind === "Rejection")
      return Effect.fail(new Value.Rejected({ rejection: value }));
    if (value._tag === "Host") {
      const service = hooks.service?.(value.value, site);
      if (service) return Effect.succeed(service);
    }
    if (value._tag === "Host" && isContextTag(value.value)) {
      const tag = value.value;
      const key = `${current.run.label}${tag.key}`;
      const known = current.run.contexts.get(key);
      if (known) return Effect.succeed(known.value);
      const given = hooks.provided.get(tag);
      if (given) {
        current.run.contexts.set(key, { tag, value: given });
        return Effect.succeed(given);
      }
      const made = Symbolic.symbolic(
        Symbolic.typeOf(tag.schema)!,
        `${current.run.label}${tag.key.slice(tag.key.lastIndexOf("/") + 1)}`,
        current.run,
      );
      current.run.contexts.set(key, { tag, value: made });
      return Effect.succeed(made);
    }
    return fail(site, "yields a value the prover has no model for");
  };

  const construct: (cls: V, args: ReadonlyArray<V>, site: Site) => Eval<V> = Effect.fnUntraced(
    function* (cls: V, args: ReadonlyArray<V>, site: Site) {
      if (cls._tag !== "Host" || !isDomainClass(cls.value))
        return yield* fail(
          site,
          `constructs ${cls._tag === "Host" ? cls.name : "a class"}, which is not an event, a rejection or a command`,
        );
      const domain = cls.value;
      const [input] = args;
      if (input !== undefined && input._tag !== "Obj" && input._tag !== "Undef")
        return yield* fail(
          site,
          `constructs ${domain.tag} from a value the prover cannot see into`,
        );
      const fields: Record<string, V> = {
        ...(input?._tag === "Obj" ? input.fields : {}),
        _tag: Value.str(domain.tag),
      };
      for (const [key, schema] of Object.entries(domain.fields)) {
        const ast = Symbolic.typeOf(schema);
        const field = fields[key];
        if (ast && field && !Symbolic.assumeFits(field, ast, current.run))
          return yield* new Value.Infeasible();
      }
      const brand: Brand = { kind: domain.kind, cls: domain };
      return Value.obj(fields, brand);
    },
  );

  const arithmetic: (operator: string, a: V, b: V, site: Site) => Eval<V> = (
    operator,
    a,
    b,
    site,
  ) => {
    const x = Library.numeric(a);
    const y = Library.numeric(b);
    if (x && y) {
      const big = Value.isBig(a);
      if (big !== Value.isBig(b)) return fail(site, `applies ${operator} to a bigint and a number`);
      if (a._tag === "Big" && b._tag === "Big") {
        const l = a.value;
        const r = b.value;
        if ((operator === "/" || operator === "%") && r === 0n)
          return fail(site, "divides a bigint by zero");
        const folded =
          operator === "+"
            ? l + r
            : operator === "-"
              ? l - r
              : operator === "*"
                ? l * r
                : operator === "/"
                  ? l / r
                  : operator === "%"
                    ? l % r
                    : operator === "<"
                      ? l < r
                      : operator === "<="
                        ? l <= r
                        : operator === ">"
                          ? l > r
                          : l >= r;
        return Effect.succeed<V>(
          typeof folded === "bigint" ? { _tag: "Big", value: folded } : Value.bool(folded),
        );
      }
      if (a._tag === "Num" && b._tag === "Num") {
        const l = a.value;
        const r = b.value;
        const folded =
          operator === "+"
            ? l + r
            : operator === "-"
              ? l - r
              : operator === "*"
                ? l * r
                : operator === "/"
                  ? l / r
                  : operator === "%"
                    ? l % r
                    : operator === "<"
                      ? l < r
                      : operator === "<="
                        ? l <= r
                        : operator === ">"
                          ? l > r
                          : l >= r;
        return Effect.succeed(typeof folded === "number" ? Value.num(folded) : Value.bool(folded));
      }
      if (operator === "/" || operator === "%") {
        // A whole number over a whole number the code writes: the solver divides those exactly.
        const divisor = b._tag === "Num" ? b.value : b._tag === "Big" ? Number(b.value) : undefined;
        if (
          divisor === undefined ||
          divisor === 0 ||
          !Number.isSafeInteger(divisor) ||
          x.sort !== "Int"
        )
          return fail(
            site,
            `divides with ${operator} in a way the prover does not translate: it reads a whole number divided by a whole number the code writes`,
          );
        const size = Math.abs(divisor);
        // JavaScript's remainder takes the sign of what is divided; the solver's is never negative.
        if (operator === "%")
          return Effect.succeed<V>({
            _tag: "Term",
            term: {
              sort: "Int",
              text: `(ite (>= ${x.text} 0) (mod ${x.text} ${size}) (- (mod (- ${x.text}) ${size})))`,
            },
            ...(big ? { big: true as const } : {}),
          });
        if (big) {
          // A bigint divides towards zero.
          const towards = `(ite (>= ${x.text} 0) (div ${x.text} ${size}) (- (div (- ${x.text}) ${size})))`;
          return Effect.succeed<V>({
            _tag: "Term",
            term: { sort: "Int", text: divisor > 0 ? towards : `(- ${towards})` },
            big: true,
          });
        }
        return Effect.succeed<V>({
          _tag: "Term",
          term: { sort: "Real", text: `(/ (to_real ${x.text}) ${Smt.real(divisor).text})` },
          quotient: { dividend: x.text, divisor },
        });
      }
      const [l, r] = Library.promote(x, y);
      // A solver counts exactly, and JavaScript rounds: a tenth and two tenths are not
      // three tenths there. Whole numbers agree, and so does comparing any two numbers.
      if (l.sort === "Real" && (operator === "+" || operator === "-" || operator === "*"))
        return fail(
          site,
          `applies ${operator} to numbers that may not be whole, which JavaScript rounds and the prover does not`,
        );
      // A division is rounded too. It still compares with a whole number as the exact one does.
      if ((isQuotient(a) && y.sort !== "Int") || (isQuotient(b) && x.sort !== "Int"))
        return fail(
          site,
          `compares a division with a number that may not be whole, which JavaScript rounds and the prover does not`,
        );
      const text = `(${operator} ${l.text} ${r.text})`;
      return Effect.succeed<V>(
        operator === "+" || operator === "-" || operator === "*"
          ? { _tag: "Term", term: { sort: l.sort, text }, ...(big ? { big: true as const } : {}) }
          : Value.term("Bool", text),
      );
    }
    if (operator === "+") {
      // A number in a string is its text. The solver knows the text of a
      // number only as the real `String` gives it, one number at a time.
      const written = (v: V) =>
        textual(v) ??
        (v._tag === "Num" || v._tag === "Big"
          ? Smt.string(String(v.value))
          : v._tag === "Term" && (v.term.sort === "Int" || v.term.sort === "Real")
            ? current.run.apply(
                `String of ${v.term.sort}`,
                v.term,
                "String",
                String,
                undefined,
                true,
              )
            : undefined);
      const s = written(a);
      const t = written(b);
      if (s && t)
        return Effect.succeed(
          a._tag !== "Term" && b._tag !== "Term"
            ? Value.str(
                String((a as { value: unknown }).value) + String((b as { value: unknown }).value),
              )
            : Value.term("String", `(str.++ ${s.text} ${t.text})`),
        );
    }
    return fail(site, `applies ${operator} to values the prover cannot do arithmetic on`);
  };

  const evaluate: Interpreter["evaluate"] = Effect.fnUntraced(function* (node: Node, env: Env) {
    const site: Site = { module: env.module, node };
    switch (node.type) {
      case "Literal": {
        const value: unknown = node.value;
        if (typeof value === "number") return Value.num(value);
        if (typeof value === "string") return Value.str(value);
        if (typeof value === "boolean") return Value.bool(value);
        if (typeof node.bigint === "string") return { _tag: "Big", value: BigInt(node.bigint) };
        return value === null && node.raw === "null"
          ? Value.nil
          : yield* fail(site, "uses a literal the prover does not read");
      }
      case "TemplateLiteral": {
        let out: V = Value.str("");
        for (const [index, quasi] of (node.quasis as ReadonlyArray<Node>).entries()) {
          out = yield* arithmetic("+", out, Value.str(quasi.value.cooked ?? ""), site);
          const expression = node.expressions[index] as Node | undefined;
          if (expression) out = yield* arithmetic("+", out, yield* evaluate(expression, env), site);
        }
        return out;
      }
      case "Identifier":
        return yield* lookup(node.name, env, site);
      case "ParenthesizedExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
      case "TSInstantiationExpression":
      case "ChainExpression":
        return yield* evaluate(node.expression, env);
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return { _tag: "Fn", node, env, effectful: false };
      case "MemberExpression": {
        const object = yield* evaluate(node.object, env);
        if (node.optional && (object._tag === "Null" || object._tag === "Undef"))
          return Value.undef;
        const key = node.computed
          ? yield* evaluate(node.property, env)
          : Value.str(node.property.name);
        return key._tag === "Str" || key._tag === "Num"
          ? yield* member(object, String(key.value), site)
          : yield* fail(site, "reads a property by a key the prover cannot see");
      }
      case "CallExpression": {
        const callee = yield* evaluate(node.callee, env);
        if (node.optional && (callee._tag === "Null" || callee._tag === "Undef"))
          return Value.undef;
        const args: Array<V> = [];
        for (const argument of node.arguments as ReadonlyArray<Node>) {
          if (argument.type === "SpreadElement") {
            const spread = forced(yield* evaluate(argument.argument, env));
            if (spread._tag !== "Arr")
              return yield* fail(site, "spreads arguments that are not a known array");
            args.push(...spread.items);
          } else args.push(yield* evaluate(argument, env));
        }
        return yield* call(callee, args, site);
      }
      case "NewExpression": {
        const cls = yield* evaluate(node.callee, env);
        const args: Array<V> = [];
        for (const argument of node.arguments as ReadonlyArray<Node>)
          args.push(yield* evaluate(argument, env));
        return yield* construct(cls, args, site);
      }
      case "YieldExpression":
        return node.delegate && node.argument
          ? yield* settle(yield* evaluate(node.argument, env), site)
          : yield* fail(site, "yields without a star");
      case "ConditionalExpression":
        return (yield* decide(yield* evaluate(node.test, env), site))
          ? yield* evaluate(node.consequent, env)
          : yield* evaluate(node.alternate, env);
      case "LogicalExpression": {
        const left = yield* evaluate(node.left, env);
        if (node.operator === "??")
          return left._tag === "Null" || left._tag === "Undef"
            ? yield* evaluate(node.right, env)
            : left;
        const truthy = yield* decide(left, site);
        // On the side that keeps the left operand, it is known true (or false) here.
        const kept = left._tag === "Term" && left.term.sort === "Bool" ? Value.bool(truthy) : left;
        return (node.operator === "&&") === truthy ? yield* evaluate(node.right, env) : kept;
      }
      case "UnaryExpression": {
        const argument = yield* evaluate(node.argument, env);
        if (node.operator === "!") {
          const t = yield* truthOf(argument, site);
          return fromTruth(typeof t === "boolean" ? !t : Smt.not(t));
        }
        if (node.operator === "-")
          return yield* arithmetic(
            "-",
            Value.isBig(argument) ? { _tag: "Big", value: 0n } : Value.num(0),
            argument,
            site,
          );
        if (node.operator === "+" && Library.numeric(argument) && !Value.isBig(argument))
          return argument;
        if (node.operator === "typeof") {
          const kind = kindOf(argument);
          if (kind !== undefined) return Value.str(kind);
        }
        return yield* fail(site, `uses ${node.operator}, which the prover does not translate`);
      }
      case "BinaryExpression": {
        const left = yield* evaluate(node.left, env);
        const right = yield* evaluate(node.right, env);
        if (node.operator === "===" || node.operator === "!==") {
          const equal = same(left, right);
          if (equal === undefined)
            return yield* fail(site, "compares values the prover does not model");
          return fromTruth(
            node.operator === "===" ? equal : typeof equal === "boolean" ? !equal : Smt.not(equal),
          );
        }
        if (["+", "-", "*", "/", "%", "<", "<=", ">", ">="].includes(node.operator))
          return yield* arithmetic(node.operator, left, right, site);
        if (node.operator === "==" || node.operator === "!=") {
          // `x == null`: nothing, of either kind.
          const nothing = (v: V) => v._tag === "Null" || v._tag === "Undef";
          if (!nothing(left) && !nothing(right))
            return yield* fail(site, `uses ${node.operator}, where the prover reads ===`);
          const other = nothing(left) ? right : left;
          if (other._tag === "Opaque")
            return yield* fail(site, "compares values the prover does not model");
          return Value.bool(nothing(other) === (node.operator === "=="));
        }
        if (node.operator === "in") {
          if ((left._tag !== "Str" && left._tag !== "Num") || right._tag !== "Obj")
            return yield* fail(site, "uses in on values the prover cannot see into");
          return Value.bool(Object.hasOwn(right.fields, String(left.value)));
        }
        return yield* fail(site, `uses ${node.operator}, which the prover does not translate`);
      }
      case "ObjectExpression": {
        const fields: Record<string, V> = {};
        for (const property of node.properties as ReadonlyArray<Node>) {
          if (property.type === "SpreadElement") {
            const spread = yield* evaluate(property.argument, env);
            if (spread._tag === "Obj" && spread.brand?.kind !== "Option")
              Object.assign(fields, spread.fields);
            else if (spread._tag !== "Null" && spread._tag !== "Undef")
              return yield* fail(site, "spreads a value the prover cannot see into");
            continue;
          }
          const key = property.computed
            ? yield* evaluate(property.key, env)
            : Value.str(
                property.key.type === "Identifier" ? property.key.name : String(property.key.value),
              );
          if (key._tag !== "Str" && key._tag !== "Num")
            return yield* fail(
              site,
              "writes a property by a key the prover cannot see: it reads an object whose keys the code writes",
            );
          fields[String(key.value)] = yield* evaluate(property.value, env);
        }
        return made(Value.obj(fields));
      }
      case "ArrayExpression": {
        const items: Array<V> = [];
        for (const element of node.elements as ReadonlyArray<Node | null>) {
          if (!element) items.push(Value.undef);
          else if (element.type === "SpreadElement") {
            const spread = forced(yield* evaluate(element.argument, env));
            if (spread._tag !== "Arr")
              return yield* fail(site, "spreads a value that is not a known array");
            items.push(...spread.items);
          } else items.push(yield* evaluate(element, env));
        }
        return made<V>({ _tag: "Arr", items });
      }
      case "AssignmentExpression": {
        if (node.operator === "=") {
          const value = yield* evaluate(node.right, env);
          yield* assign(node.left, value, env, site);
          return value;
        }
        const operator: string = node.operator.slice(0, -1);
        const before = yield* evaluate(node.left, env);
        let value: V;
        if (operator === "??")
          value =
            before._tag === "Null" || before._tag === "Undef"
              ? yield* evaluate(node.right, env)
              : before;
        else if (operator === "||" || operator === "&&")
          value =
            (yield* decide(before, site)) === (operator === "&&")
              ? yield* evaluate(node.right, env)
              : before;
        else if (["+", "-", "*", "/", "%"].includes(operator))
          value = yield* arithmetic(operator, before, yield* evaluate(node.right, env), site);
        else return yield* fail(site, `uses ${node.operator}, which the prover does not translate`);
        yield* assign(node.left, value, env, site);
        return value;
      }
      case "UpdateExpression": {
        const before = yield* evaluate(node.argument, env);
        const after = yield* arithmetic(
          node.operator === "++" ? "+" : "-",
          before,
          Value.isBig(before) ? { _tag: "Big", value: 1n } : Value.num(1),
          site,
        );
        yield* assign(node.argument, after, env, site);
        return node.prefix ? after : before;
      }
      default:
        return yield* fail(site, `uses a ${node.type}, which the prover does not read`);
    }
  });

  /** Run statements in order. The result is what they returned, or `undefined` when they did not. */
  const execute: (statements: ReadonlyArray<Node>, env: Env) => Eval<V | undefined> =
    Effect.fnUntraced(function* (statements: ReadonlyArray<Node>, env: Env) {
      for (const statement of statements) {
        const site: Site = { module: env.module, node: statement };
        switch (statement.type) {
          case "VariableDeclaration":
            for (const declarator of statement.declarations as ReadonlyArray<Node>) {
              yield* bind(
                declarator.id,
                declarator.init ? yield* evaluate(declarator.init, env) : Value.undef,
                env.scope,
                env,
              );
            }
            break;
          case "ExpressionStatement":
            yield* evaluate(statement.expression, env);
            break;
          case "ReturnStatement":
            return statement.argument ? yield* evaluate(statement.argument, env) : Value.undef;
          case "BlockStatement": {
            const returned = yield* execute(statement.body, { ...env, scope: child(env.scope) });
            if (returned) return returned;
            break;
          }
          case "IfStatement": {
            const branch: Node | null = (yield* decide(yield* evaluate(statement.test, env), site))
              ? statement.consequent
              : statement.alternate;
            if (branch) {
              const returned = yield* execute([branch], { ...env, scope: child(env.scope) });
              if (returned) return returned;
            }
            break;
          }
          case "SwitchStatement": {
            const subject = yield* evaluate(statement.discriminant, env);
            const cases = statement.cases as ReadonlyArray<Node>;
            let at = -1;
            for (const [index, entry] of cases.entries()) {
              if (!entry.test) continue;
              const equal = same(subject, yield* evaluate(entry.test, env));
              if (equal === undefined)
                return yield* fail(site, "switches on a value the prover does not model");
              if (typeof equal === "boolean" ? equal : current.run.branch(equal)) {
                at = index;
                break;
              }
            }
            if (at < 0) at = cases.findIndex((entry) => !entry.test);
            if (at < 0) break;
            // A case without a `break` runs on into the next.
            const body = cases
              .slice(at)
              .flatMap((entry) => entry.consequent as ReadonlyArray<Node>);
            const returned = yield* execute(body, { ...env, scope: child(env.scope) });
            if (returned && returned !== BREAK) return returned;
            break;
          }
          case "BreakStatement":
            return statement.label ? yield* fail(site, "breaks to a label") : BREAK;
          case "ContinueStatement":
            return statement.label ? yield* fail(site, "continues to a label") : CONTINUE;
          case "ForOfStatement":
          case "ForInStatement": {
            if (statement.await) return yield* fail(site, "loops with for await");
            const subject = forced(yield* evaluate(statement.right, env));
            const items =
              statement.type === "ForOfStatement"
                ? subject._tag === "Arr"
                  ? [...subject.items]
                  : undefined
                : subject._tag === "Obj"
                  ? Object.keys(subject.fields).map(Value.str)
                  : undefined;
            if (!items)
              return yield* fail(
                site,
                subject._tag === "Opaque"
                  ? `loops over ${subject.what}, whose items the prover does not know`
                  : "loops over a value whose items the prover does not know",
              );
            const left: Node = statement.left;
            for (const item of items) {
              const scope = child(env.scope);
              const inner = { ...env, scope };
              if (left.type === "VariableDeclaration")
                yield* bind(left.declarations[0].id, item, scope, inner);
              else yield* assign(left, item, env, site);
              const returned = yield* turn(statement.body, inner);
              if (returned === BREAK) break;
              if (returned) return returned;
            }
            break;
          }
          case "ForStatement":
          case "WhileStatement":
          case "DoWhileStatement": {
            const inner = { ...env, scope: child(env.scope) };
            const init: Node | null = statement.init ?? null;
            if (init?.type === "VariableDeclaration") {
              const returned = yield* execute([init], inner);
              if (returned) return returned;
            } else if (init) yield* evaluate(init, inner);
            let turns = 0;
            let first = statement.type === "DoWhileStatement";
            while (first || (yield* goesOn(statement.test ?? null, inner, site))) {
              first = false;
              if (++turns > MAX_TURNS)
                return yield* fail(site, `loops more than ${MAX_TURNS} times`);
              const returned = yield* turn(statement.body, { ...inner, scope: child(inner.scope) });
              if (returned === BREAK) break;
              if (returned) return returned;
              if (statement.update) yield* evaluate(statement.update, inner);
            }
            break;
          }
          case "EmptyStatement":
          case "TSTypeAliasDeclaration":
          case "TSInterfaceDeclaration":
            break;
          case "FunctionDeclaration":
            env.scope.variables.set(statement.id.name, {
              _tag: "Fn",
              node: statement,
              env,
              effectful: false,
            });
            break;
          default:
            return yield* fail(site, `uses a ${statement.type}, which the prover does not read`);
        }
      }
      return undefined;
    });

  return { current, evaluate, call, settle, member, decide, truth: truthOf, moduleEnv, hooks };
};
