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
  v._tag === "Str" ||
  v._tag === "Bool" ||
  v._tag === "Null" ||
  v._tag === "Undef";

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

/** Leaves the `switch` it is in. */
const BREAK: V = { _tag: "Opaque", what: "break" };

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
        return yield* evaluate(declaration.init, moduleEnv(module)).pipe(
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
    if (name === "Math") return { _tag: "Lib", module: "Math", path: [] } as V;
    return yield* fail(site, `refers to ${name}, which the prover cannot find`);
  });

  const library = Library.make({
    current,
    provided: hooks.provided,
    extra: hooks.models,
    call: (fn, args, site) => call(fn, args, site),
    settle: (value, site) => settle(value, site),
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

  const member: Interpreter["member"] = Effect.fnUntraced(function* (
    value: V,
    key: string,
    site: Site,
  ) {
    switch (value._tag) {
      case "Obj":
        return value.fields[key] ?? Value.undef;
      case "Arr":
        if (key === "length") return Value.num(value.items.length);
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
        case "ObjectPattern":
          for (const property of pattern.properties as ReadonlyArray<Node>) {
            if (property.type !== "Property" || property.computed)
              return yield* fail(site, "destructures in a way the prover does not read");
            const key =
              property.key.type === "Identifier" ? property.key.name : String(property.key.value);
            yield* bind(property.value, yield* member(value, key, site), scope, env);
          }
          return;
        case "ArrayPattern":
          for (const [index, element] of (
            pattern.elements as ReadonlyArray<Node | null>
          ).entries()) {
            if (element)
              yield* bind(element, yield* member(value, String(index), site), scope, env);
          }
          return;
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
        yield* bind(parameter, args[index] ?? Value.undef, scope, env);
      }
      const body: Node = fn.node.body;
      if (body.type !== "BlockStatement") return yield* evaluate(body, env);
      return (yield* execute(body.body, env)) ?? Value.undef;
    });

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
      if (operator === "/" || operator === "%")
        return fail(site, `divides with ${operator}, which the prover does not translate`);
      const [l, r] = Library.promote(x, y);
      const text = `(${operator} ${l.text} ${r.text})`;
      return Effect.succeed(
        operator === "+" || operator === "-" || operator === "*"
          ? Value.term(l.sort, text)
          : Value.term("Bool", text),
      );
    }
    if (operator === "+") {
      const s = textual(a) ?? (a._tag === "Num" ? Smt.string(String(a.value)) : undefined);
      const t = textual(b) ?? (b._tag === "Num" ? Smt.string(String(b.value)) : undefined);
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
          if (argument.type === "SpreadElement") return yield* fail(site, "spreads arguments");
          args.push(yield* evaluate(argument, env));
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
        if (node.operator === "-") return yield* arithmetic("-", Value.num(0), argument, site);
        if (node.operator === "+" && Library.numeric(argument)) return argument;
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
        return yield* fail(site, `uses ${node.operator}, which the prover does not translate`);
      }
      case "ObjectExpression": {
        const fields: Record<string, V> = {};
        for (const property of node.properties as ReadonlyArray<Node>) {
          if (property.type === "SpreadElement") {
            const spread = yield* evaluate(property.argument, env);
            if (spread._tag === "Obj") Object.assign(fields, spread.fields);
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
            return yield* fail(site, "writes a property by a key the prover cannot see");
          fields[String(key.value)] = yield* evaluate(property.value, env);
        }
        return Value.obj(fields);
      }
      case "ArrayExpression": {
        const items: Array<V> = [];
        for (const element of node.elements as ReadonlyArray<Node | null>) {
          if (!element) items.push(Value.undef);
          else if (element.type === "SpreadElement") {
            const spread = yield* evaluate(element.argument, env);
            if (spread._tag !== "Arr")
              return yield* fail(site, "spreads a value that is not a known array");
            items.push(...spread.items);
          } else items.push(yield* evaluate(element, env));
        }
        return { _tag: "Arr", items };
      }
      case "AssignmentExpression": {
        if (node.left.type !== "Identifier" || node.operator !== "=")
          return yield* fail(site, "assigns in a way the prover does not read");
        const value = yield* evaluate(node.right, env);
        for (let scope: Scope | undefined = env.scope; scope; scope = scope.parent) {
          if (scope.variables.has(node.left.name)) {
            scope.variables.set(node.left.name, value);
            return value;
          }
        }
        return yield* fail(site, `assigns to ${node.left.name}, which is not a local variable`);
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
