import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type { Sort, Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";

/** A node of the parsed source. Only the fields the prover reads are typed. */
export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: any;
}

/** One parsed source file, and the same module loaded for its runtime values. */
export interface Module {
  readonly path: string;
  /** The file's text: a node's `start` and `end` are places in it. */
  readonly source: string;
  readonly lineStarts: ReadonlyArray<number>;
  readonly program: Node;
  readonly declarations: ReadonlyMap<string, Declaration>;
  readonly imports: ReadonlyMap<string, Import>;
  /** The specifiers of `export * from`. */
  readonly stars: ReadonlyArray<string>;
  /** The file each relative specifier names. */
  readonly resolved: ReadonlyMap<string, string>;
  /** The module as Node loaded it: classes, schemas and constants. */
  readonly exports: Readonly<Record<string, unknown>>;
}

export type Declaration =
  | { readonly _tag: "Const"; readonly init: Node | undefined }
  | { readonly _tag: "Function"; readonly node: Node }
  | { readonly _tag: "Class"; readonly node: Node };

export interface Import {
  readonly specifier: string;
  /** The exported name, `*` for the namespace, or `default`. */
  readonly imported: string;
}

export interface Scope {
  readonly variables: Map<string, V>;
  readonly parent: Scope | undefined;
}

/** Where a function was written: the scope it closes over and its file. */
export interface Env {
  readonly scope: Scope;
  readonly module: Module;
}

/** A domain class instance: an event, a rejection or a command. */
export interface Brand {
  /**
   * `Option`: an `effect/Option`, whose `_tag` is `Some` or `None`.
   * `Recorded`: an event a decision recorded on an instance it read, whose
   * `cls` is that instance's place among the ones read.
   * `Matcher`: an `effect/Match` matcher being built, whose `cls` is the
   * value it matches and the cases it has so far.
   * `Duration`: an `effect/Duration` of a whole number of milliseconds, kept
   * in its one field, `millis`.
   * `Result`: an `effect/Result`, whose `_tag` is `Success` or `Failure`.
   * `BigDecimal`: an `effect/BigDecimal`, kept in its one field, `value`:
   * the text of a decimal the prover knows, or a real number of the solver's.
   * `HashSet` and `HashMap`: an `effect/HashSet` kept in `items`, and an
   * `effect/HashMap` kept in `entries` as pairs. No two items, and no two
   * keys, are equal on the path the value is on.
   * `Data`: an instance of a class of `effect/Data` or `effect/Schema`,
   * whose `cls` is the class.
   * `Ref`: an `effect/Ref` the code made, with what it holds now in `value`.
   * `Rational`: an `effect/Rational`, kept in `value` as a `BigDecimal` is.
   * `Redacted`: an `effect/Redacted`, with what it hides in `value`.
   */
  readonly kind:
    | "Event"
    | "Rejection"
    | "Command"
    | "Option"
    | "Recorded"
    | "Matcher"
    | "Duration"
    | "Result"
    | "BigDecimal"
    | "HashSet"
    | "HashMap"
    | "Data"
    | "Ref"
    | "Rational"
    | "Redacted";
  readonly cls: unknown;
}

export type OpticStep =
  | { readonly _tag: "Tag"; readonly tag: string }
  | { readonly _tag: "Key"; readonly key: string };

/**
 * A value while the prover runs the code. Concrete values are computed as
 * JavaScript would; a `Term` stands for every value an input can take.
 */
export type V =
  | { readonly _tag: "Num"; readonly value: number }
  | { readonly _tag: "Big"; readonly value: bigint }
  | { readonly _tag: "Str"; readonly value: string }
  | { readonly _tag: "Bool"; readonly value: boolean }
  | { readonly _tag: "Null" }
  | { readonly _tag: "Undef" }
  | {
      readonly _tag: "Term";
      readonly term: Term;
      /** A `bigint`: it has no largest value, and never meets a `number`. */
      readonly big?: true;
      /**
       * One whole number divided by another. JavaScript rounds the result,
       * so only what is exact of it is translated: its floor and ceiling,
       * and how it compares with a whole number.
       */
      readonly quotient?: { readonly dividend: string; readonly divisor: number };
    }
  | { readonly _tag: "Obj"; readonly fields: Readonly<Record<string, V>>; readonly brand?: Brand }
  | { readonly _tag: "Arr"; readonly items: ReadonlyArray<V> }
  /**
   * A list an input holds, before the code looks at it. Looking gives it a
   * length, which the run chooses, and an input for each item.
   */
  | {
      readonly _tag: "List";
      readonly name: string;
      readonly ast: unknown;
      /**
       * The list holds a hash set's items, or a hash map's pairs: no two
       * items, or no two keys, are equal.
       */
      readonly distinct?: "items" | "keys";
    }
  | {
      readonly _tag: "Fn";
      readonly node: Node;
      readonly env: Env;
      /** Wrapped by `Effect.fn`: calling it gives an effect. */
      readonly effectful: boolean;
      /**
       * The function as its file exports it. Where the prover cannot read the
       * body, a call is a value it does not look inside, and this gives it.
       */
      readonly real?: {
        readonly name: string;
        readonly call: (...args: ReadonlyArray<unknown>) => unknown;
      };
    }
  | {
      readonly _tag: "Native";
      readonly name: string;
      readonly call: (args: ReadonlyArray<V>, site: Site) => Eval<V>;
    }
  | { readonly _tag: "Optic"; readonly path: ReadonlyArray<OpticStep> }
  | {
      readonly _tag: "Lib";
      readonly module: string;
      readonly path: ReadonlyArray<string>;
      /** What the package gives here as the runtime loads it, where the prover looked. */
      readonly host?: unknown;
    }
  | { readonly _tag: "Namespace"; readonly module: Module }
  | { readonly _tag: "Host"; readonly value: unknown; readonly name: string }
  | { readonly _tag: "Effect"; readonly run: Eval<V> }
  /**
   * An `effect/Stream`, as the library runs one: opening it gives a pull, and
   * each pull gives the next chunk of items, or `undefined` at the end.
   */
  | { readonly _tag: "Stream"; readonly open: Eval<Pull> }
  | { readonly _tag: "Time"; readonly millis: Term }
  | { readonly _tag: "Opaque"; readonly what: string }
  /**
   * What a function the prover does not read returned. The prover does not
   * look inside it: it is passed along, kept and recorded, and it is the same
   * value as another call of the function on the same arguments.
   */
  | {
      readonly _tag: "Applied";
      /** The function's name. */
      readonly name: string;
      /** The real function: it gives the value where the real code is run. */
      readonly call: (...args: ReadonlyArray<unknown>) => unknown;
      readonly args: ReadonlyArray<V>;
      /** Why the prover does not read the function, as what follows its name in a message. */
      readonly why: string;
      /** Text two calls share only when they are the same function on the same arguments. */
      readonly key: string;
    };

export const num = (value: number): V => ({ _tag: "Num", value });
export const str = (value: string): V => ({ _tag: "Str", value });
export const bool = (value: boolean): V => ({ _tag: "Bool", value });
export const nil: V = { _tag: "Null" };
export const undef: V = { _tag: "Undef" };
export const term = (sort: Sort, text: string): V => ({ _tag: "Term", term: { sort, text } });
export const obj = (fields: Readonly<Record<string, V>>, brand?: Brand): V =>
  brand ? { _tag: "Obj", fields, brand } : { _tag: "Obj", fields };

const OPTION: Brand = { kind: "Option", cls: undefined };

/** `Option.none()`: there is one, as in the library. */
export const none: V = obj({ _tag: str("None") }, OPTION);
/** `Option.some(value)`. */
export const some = (value: V): V => obj({ _tag: str("Some"), value }, OPTION);

/** What an `Option` holds: `undefined` when the value is not one. */
export const optionOf = (
  v: V | undefined,
): { readonly _tag: "None" } | { readonly _tag: "Some"; readonly value: V } | undefined => {
  if (v?._tag !== "Obj" || v.brand?.kind !== "Option") return undefined;
  const tag = v.fields._tag;
  return tag?._tag === "Str" && tag.value === "Some"
    ? { _tag: "Some", value: v.fields.value ?? undef }
    : { _tag: "None" };
};

const identities = new WeakMap<object, number>();
let identityCount = 0;

/** A number an object keeps for as long as it lives: two objects never share one. */
const identityOf = (object: object): number => {
  const known = identities.get(object);
  if (known !== undefined) return known;
  const made = ++identityCount;
  identities.set(object, made);
  return made;
};

/** A value as text two values share only when they are known to be the same. */
export const keyOf = (v: V): string => {
  switch (v._tag) {
    case "Num":
      return `n${v.value}`;
    case "Big":
      return `${v.value}n`;
    case "Str":
      return JSON.stringify(v.value);
    case "Bool":
      return String(v.value);
    case "Null":
      return "null";
    case "Undef":
      return "undefined";
    case "Term":
      return `(${v.big ? "big " : ""}${v.term.text})`;
    case "Time":
      return `(time ${v.millis.text})`;
    case "List":
      return `(list ${JSON.stringify(v.name)})`;
    case "Arr":
      return `[${v.items.map(keyOf).join(",")}]`;
    case "Obj":
      return `{${Object.keys(v.fields)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${keyOf(v.fields[key]!)}`)
        .join(",")}}`;
    case "Applied":
      return v.key;
    default:
      return `#${identityOf(v)}`;
  }
};

/** A call of an opaque function on these arguments. */
export const applied = (
  name: string,
  call: (...args: ReadonlyArray<unknown>) => unknown,
  args: ReadonlyArray<V>,
  why: string,
): V => ({
  _tag: "Applied",
  name,
  call,
  args,
  why,
  key: `(call #${identityOf(call)} ${args.map(keyOf).join(" ")})`,
});

/** Whether a value is a `bigint`. */
export const isBig = (v: V): boolean => v._tag === "Big" || (v._tag === "Term" && v.big === true);

/** A place in the source, for a message that names it. */
export interface Site {
  readonly module: Module;
  readonly node: Node;
}

/** The next chunk of a stream's items, or `undefined` when it has ended. */
export type Pull = Eval<ReadonlyArray<V> | undefined>;

/** `decide` refused the command. */
export class Rejected extends Data.TaggedError("Rejected")<{
  readonly rejection: V;
  /** The effect died: nothing that handles a failure handles it. */
  readonly defect?: boolean;
}> {}

/** The prover met code it cannot turn into a formula. */
export class NotTranslated extends Data.TaggedError("NotTranslated")<{
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  /**
   * Whether the code reaches outside what the prover reads: a global, a
   * function it has no model for, a value it was given and changes. Nothing
   * then says the function it is in gives the same result for the same
   * arguments.
   */
  readonly reaches: boolean;
}> {}

/** The inputs this path assumes cannot occur. */
export class Infeasible extends Data.TaggedError("Infeasible")<{}> {}

export type Stop = Rejected | NotTranslated | Infeasible;
export type Eval<A> = Effect.Effect<A, Stop>;

export const lineOf = (module: Module, offset: number): number => {
  let low = 0;
  let high = module.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (module.lineStarts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
};

export const notTranslated = (site: Site, reason: string, reaches = false): NotTranslated =>
  new NotTranslated({
    file: site.module.path,
    line: lineOf(site.module, site.node.start),
    reason,
    reaches,
  });

/** A function the prover does not look inside: its real implementation checks each answer. */
export interface Application {
  readonly term: string;
  readonly argument: string;
  /** The sort of the argument. */
  readonly sort: Sort;
  /** The real function, on the argument's value in a counterexample. */
  readonly real: (argument: number) => string;
  /** Whether different arguments always give different results. */
  readonly injective: boolean;
}

/**
 * One run of the code along one path. A run replays the choices in `prefix`,
 * then takes the first option at every new one; the driver re-runs with the
 * last choice advanced until every path has been taken.
 */
export class Run {
  private cursor = 0;
  readonly taken: Array<{ chosen: number; readonly of: number }> = [];
  /** Declarations for the solver, by name. */
  readonly declarations = new Map<string, string>();
  /** The input constants, in the order they were made. */
  readonly constants: Array<string> = [];
  /** What holds on this path. */
  readonly conditions: Array<string> = [];
  readonly applications = new Map<string, Application>();
  /** The request contexts the code read, by key: each is an input, made once. */
  readonly contexts = new Map<string, { readonly tag: unknown; readonly value: V }>();
  /** The lists the code looked at, by name, with the items this path gave each. */
  readonly lists = new Map<string, V>();
  /** The lists tried only up to a length, by name: longer ones were not looked at. */
  readonly bounds = new Map<string, number>();
  /** The constants that are a `bigint`: they have no largest value. */
  readonly bigs = new Set<string>();
  /**
   * Each hash set and hash map the code read in order, with the order this
   * path gave its items. The real one gives them in the order of their
   * hashes, which the prover does not know: every order is a path.
   */
  readonly orders: Array<{
    readonly kind: "HashSet" | "HashMap";
    /** What the set or the map holds, in no order: one that holds the same is read in the same order. */
    readonly key: string;
    readonly items: ReadonlyArray<V>;
  }> = [];
  /**
   * Each result of an opaque function the code tested, by the call's key:
   * whether it is truthy is an input, which the real function decides.
   */
  readonly tests = new Map<string, { readonly term: Term; readonly applied: V }>();
  /**
   * The command being run, when a run has several: a prefix on the name of
   * each request context it reads, so every command reads its own.
   */
  label = "";
  private readonly decided = new Map<string, boolean>();

  constructor(
    private readonly prefix: ReadonlyArray<number>,
    /** Picks at a choice the prefix does not make: without it, the first option. */
    private readonly pick?: (of: number) => number,
  ) {}

  /**
   * A run that goes on from the end of this one: what holds here holds there,
   * and its choices start over. One command of a sequence is then read once,
   * however many sequences go on from it.
   */
  fork(prefix: ReadonlyArray<number>, pick?: (of: number) => number): Run {
    const next = new Run(prefix, pick);
    for (const [name, declaration] of this.declarations) next.declarations.set(name, declaration);
    next.constants.push(...this.constants);
    next.conditions.push(...this.conditions);
    for (const [text, application] of this.applications) next.applications.set(text, application);
    for (const [key, context] of this.contexts) next.contexts.set(key, context);
    for (const [name, list] of this.lists) next.lists.set(name, list);
    for (const [name, bound] of this.bounds) next.bounds.set(name, bound);
    for (const name of this.bigs) next.bigs.add(name);
    next.orders.push(...this.orders);
    for (const [key, test] of this.tests) next.tests.set(key, test);
    for (const [condition, taken] of this.decided) next.decided.set(condition, taken);
    next.label = this.label;
    return next;
  }

  /** Pick one of `of` options. */
  choose(of: number): number {
    const chosen = this.prefix[this.cursor] ?? this.pick?.(of) ?? 0;
    this.cursor++;
    this.taken.push({ chosen, of });
    return chosen;
  }

  /** A fresh input of the given sort. */
  constant(name: string, sort: Sort, big = false): Term {
    const text = Smt.symbol(name);
    if (big) this.bigs.add(text);
    if (!this.declarations.has(text)) {
      this.declarations.set(text, `(declare-const ${text} ${sort})`);
      this.constants.push(text);
    }
    return { sort, text };
  }

  assume(condition: string): void {
    if (condition !== "true") this.conditions.push(condition);
  }

  /** Take one side of a condition, and remember which. */
  branch(condition: string): boolean {
    if (condition === "true") return true;
    if (condition === "false") return false;
    const known = this.decided.get(condition);
    if (known !== undefined) return known;
    const taken = this.choose(2) === 0;
    this.decided.set(condition, taken);
    this.conditions.push(taken ? condition : Smt.not(condition));
    return taken;
  }

  /** Whether what an opaque function returned is truthy: an input, the same for the same call. */
  truthy(applied: V & { readonly _tag: "Applied" }): Term {
    const known = this.tests.get(applied.key);
    if (known) return known.term;
    const term = this.constant(`${applied.name} call ${this.tests.size + 1} is truthy`, "Bool");
    this.tests.set(applied.key, { term, applied });
    return term;
  }

  /** `name(argument)`, for a function known only by its real implementation. */
  apply(
    name: string,
    argument: Term,
    result: Sort,
    real: (argument: number) => string,
    known?: (result: Term) => string,
    injective = false,
  ): Term {
    const fn = Smt.symbol(name);
    this.declarations.set(fn, `(declare-fun ${fn} (${argument.sort}) ${result})`);
    const text = `(${fn} ${argument.text})`;
    if (!this.applications.has(text) && known) this.assume(known({ sort: result, text }));
    this.applications.set(text, {
      term: text,
      argument: argument.text,
      sort: argument.sort,
      real,
      injective,
    });
    return { sort: result, text };
  }
}

/** The choices of the next path after `taken`, or `undefined` when every path was taken. */
export const nextPrefix = (
  taken: ReadonlyArray<{ readonly chosen: number; readonly of: number }>,
): ReadonlyArray<number> | undefined => {
  const choices = taken.map((t) => ({ ...t }));
  while (
    choices.length > 0 &&
    choices[choices.length - 1]!.chosen + 1 >= choices[choices.length - 1]!.of
  )
    choices.pop();
  if (choices.length === 0) return undefined;
  choices[choices.length - 1]!.chosen++;
  return choices.map((c) => c.chosen);
};
