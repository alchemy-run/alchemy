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
  | { readonly _tag: "Class" };

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
   */
  readonly kind: "Event" | "Rejection" | "Command" | "Option" | "Recorded" | "Matcher";
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
  | { readonly _tag: "List"; readonly name: string; readonly ast: unknown }
  | {
      readonly _tag: "Fn";
      readonly node: Node;
      readonly env: Env;
      /** Wrapped by `Effect.fn`: calling it gives an effect. */
      readonly effectful: boolean;
    }
  | {
      readonly _tag: "Native";
      readonly name: string;
      readonly call: (args: ReadonlyArray<V>, site: Site) => Eval<V>;
    }
  | { readonly _tag: "Optic"; readonly path: ReadonlyArray<OpticStep> }
  | { readonly _tag: "Lib"; readonly module: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Namespace"; readonly module: Module }
  | { readonly _tag: "Host"; readonly value: unknown; readonly name: string }
  | { readonly _tag: "Effect"; readonly run: Eval<V> }
  | { readonly _tag: "Time"; readonly millis: Term }
  | { readonly _tag: "Opaque"; readonly what: string };

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

/** Whether a value is a `bigint`. */
export const isBig = (v: V): boolean => v._tag === "Big" || (v._tag === "Term" && v.big === true);

/** A place in the source, for a message that names it. */
export interface Site {
  readonly module: Module;
  readonly node: Node;
}

/** `decide` refused the command. */
export class Rejected extends Data.TaggedError("Rejected")<{ readonly rejection: V }> {}

/** The prover met code it cannot turn into a formula. */
export class NotTranslated extends Data.TaggedError("NotTranslated")<{
  readonly file: string;
  readonly line: number;
  readonly reason: string;
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

export const notTranslated = (site: Site, reason: string): NotTranslated =>
  new NotTranslated({
    file: site.module.path,
    line: lineOf(site.module, site.node.start),
    reason,
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
