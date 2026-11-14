import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** The sorts the prover gives a TypeScript value. */
export type Sort = "Int" | "Real" | "Bool" | "String";

/** A formula or value in the solver's language (SMT-LIB text) and its sort. */
export interface Term {
  readonly sort: Sort;
  readonly text: string;
}

/** A symbol, quoted so any TypeScript name is one. */
export const symbol = (name: string): string =>
  `|${name.replaceAll("|", "_").replaceAll("\\", "_")}|`;

const digits = (n: number): string =>
  Number.isInteger(n)
    ? BigInt(n).toString()
    : n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });

export const int = (n: number): Term => ({
  sort: "Int",
  text: n < 0 ? `(- ${digits(-n)})` : digits(n),
});

export const real = (n: number): Term => {
  const body = Number.isInteger(n) ? `${digits(Math.abs(n))}.0` : digits(Math.abs(n));
  return { sort: "Real", text: n < 0 ? `(- ${body})` : body };
};

export const string = (value: string): Term => {
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    text +=
      char === '"'
        ? '""'
        : code < 0x20 || code > 0x7e || char === "\\"
          ? `\\u{${code.toString(16)}}`
          : char;
  }
  return { sort: "String", text: `"${text}"` };
};

export const bool = (value: boolean): Term => ({ sort: "Bool", text: value ? "true" : "false" });

export const not = (term: string): string =>
  term === "true" ? "false" : term === "false" ? "true" : `(not ${term})`;

/** The solver could not be loaded, or answered with an error. */
export class SolverError extends Data.TaggedError("SolverError")<{
  readonly message: string;
}> {}

/** A parsed piece of the solver's output. */
export type Sexp =
  | { readonly _tag: "Atom"; readonly text: string }
  | { readonly _tag: "Text"; readonly value: string }
  | { readonly _tag: "List"; readonly items: ReadonlyArray<Sexp> };

/** Parse the solver's output: a sequence of S-expressions. */
export const parse = (input: string): ReadonlyArray<Sexp> => {
  let at = 0;
  const read = (): Sexp | undefined => {
    while (at < input.length && /\s/.test(input[at]!)) at++;
    if (at >= input.length) return undefined;
    const char = input[at]!;
    if (char === "(") {
      at++;
      const items: Array<Sexp> = [];
      for (;;) {
        while (at < input.length && /\s/.test(input[at]!)) at++;
        if (at >= input.length) break;
        if (input[at] === ")") {
          at++;
          break;
        }
        const item = read();
        if (item === undefined) break;
        items.push(item);
      }
      return { _tag: "List", items };
    }
    if (char === '"') {
      at++;
      let value = "";
      while (at < input.length) {
        if (input[at] === '"') {
          if (input[at + 1] === '"') {
            value += '"';
            at += 2;
            continue;
          }
          at++;
          break;
        }
        const escape = /^\\u\{([0-9a-fA-F]+)\}/.exec(input.slice(at, at + 12));
        if (escape) {
          value += String.fromCodePoint(Number.parseInt(escape[1]!, 16));
          at += escape[0].length;
          continue;
        }
        value += input[at];
        at++;
      }
      return { _tag: "Text", value };
    }
    if (char === "|") {
      const end = input.indexOf("|", at + 1);
      const text = input.slice(at, end < 0 ? input.length : end + 1);
      at += text.length;
      return { _tag: "Atom", text };
    }
    const start = at;
    while (at < input.length && !/[\s()]/.test(input[at]!)) at++;
    return { _tag: "Atom", text: input.slice(start, at) };
  };
  const out: Array<Sexp> = [];
  for (let item = read(); item !== undefined; item = read()) out.push(item);
  return out;
};

/** The JavaScript value of a value the solver printed, or `undefined` when it is not one. */
export const valueOf = (sexp: Sexp): number | string | boolean | undefined => {
  if (sexp._tag === "Text") return sexp.value;
  if (sexp._tag === "Atom") {
    if (sexp.text === "true") return true;
    if (sexp.text === "false") return false;
    const n = Number(sexp.text);
    return Number.isNaN(n) ? undefined : n;
  }
  const [head, ...rest] = sexp.items;
  if (head?._tag !== "Atom") return undefined;
  const numbers = rest.map(valueOf);
  if (!numbers.every((n) => typeof n === "number")) return undefined;
  const [a, b] = numbers as Array<number>;
  if (head.text === "-" && a !== undefined) return b === undefined ? -a : a - b;
  if (head.text === "/" && a !== undefined && b !== undefined) return a / b;
  return undefined;
};

/** One question for the solver: can every assertion hold at once? */
export interface Query {
  readonly declarations: ReadonlyArray<string>;
  readonly assertions: ReadonlyArray<string>;
  /** Terms to read back when the answer is `Sat`. */
  readonly values: ReadonlyArray<string>;
}

export type Answer =
  | { readonly _tag: "Unsat" }
  | { readonly _tag: "Sat"; readonly values: ReadonlyArray<number | string | boolean | undefined> }
  | { readonly _tag: "Unknown"; readonly reason: string };

export interface Solver {
  readonly check: (query: Query) => Effect.Effect<Answer, SolverError>;
}

/** A symbol without its quotes. */
const bare = (text: string): string =>
  text.startsWith("|") && text.endsWith("|") ? text.slice(1, -1) : text;

/** The sort each declaration gives its symbol: the last item of `declare-const` and `declare-fun`. */
const sortsOf = (declarations: ReadonlyArray<string>): ReadonlyMap<string, string> => {
  const sorts = new Map<string, string>();
  for (const declaration of declarations) {
    const [list] = parse(declaration);
    if (list?._tag !== "List") continue;
    const name = list.items[1];
    const sort = list.items.at(-1);
    if (name?._tag === "Atom" && sort?._tag === "Atom") sorts.set(bare(name.text), sort.text);
  }
  return sorts;
};

/** The symbol that decides a term's sort: the constant, or the function applied. */
const headOf = (text: string): string | undefined => {
  const [term] = parse(text);
  const head = term?._tag === "List" ? term.items[0] : term;
  return head?._tag === "Atom" ? bare(head.text) : undefined;
};

/** A name no TypeScript value is given: the constant a value is read back through. */
const READ = "$read.";

/**
 * Z3, compiled to WebAssembly. One instance serves every query, each in a
 * solver of its own; it is torn down with the scope.
 *
 * A query is loaded with `solver_from_string`, which reads the text before it
 * returns. Z3's `eval_smtlib2_string` hands the text to another thread and
 * frees it first, so now and then the solver reads garbage.
 */
export const solver: Effect.Effect<Solver, SolverError, Scope.Scope> = Effect.gen(function* () {
  const failed = (step: string) => (cause: unknown) =>
    new SolverError({ message: `${step}: ${String(cause)}` });
  const z3 = yield* Effect.tryPromise({
    try: () => import("z3-solver"),
    catch: failed("z3-solver is not installed (it is an optional peer of @alchemy.run/domain)"),
  });
  const { Z3, context } = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => z3.init(),
      catch: failed("z3-solver did not start (it runs under Node, not Bun)"),
    }).pipe(
      Effect.map((started) => {
        const config = started.Z3.mk_config();
        started.Z3.set_param_value(config, "timeout", "5000");
        const context = started.Z3.mk_context(config);
        // Models print as `(define-fun name () Sort value)`, which `parse` reads.
        started.Z3.set_ast_print_mode(context, z3.Z3_ast_print_mode.Z3_PRINT_SMTLIB2_COMPLIANT);
        return {
          Z3: started.Z3,
          em: started.em as { readonly PThread?: { readonly terminateAllThreads?: () => void } },
          context,
        };
      }),
    ),
    (started) =>
      Effect.sync(() => {
        started.Z3.del_context(started.context);
        started.em.PThread?.terminateAllThreads?.();
      }),
  );

  /** A call into Z3 that returns at once. Z3 records an error instead of throwing. */
  const call = <A>(step: string, text: string, run: () => A): Effect.Effect<A, SolverError> =>
    Effect.try({ try: run, catch: failed(step) }).pipe(
      Effect.flatMap((result) => {
        const code = Z3.get_error_code(context);
        return Number(code) === 0
          ? Effect.succeed(result)
          : Effect.fail(
              new SolverError({ message: `${step}: ${Z3.get_error_msg(context, code)}\n${text}` }),
            );
      }),
    );

  const check = Effect.fn(function* (query: Query) {
    const sorts = sortsOf(query.declarations);
    const reads: Array<string> = [];
    for (const [index, value] of query.values.entries()) {
      const sort = sorts.get(headOf(value) ?? "");
      if (sort === undefined)
        return yield* new SolverError({
          message: `z3 cannot read back ${value}: nothing declares it`,
        });
      reads.push(
        `(declare-const ${READ}${index} ${sort})`,
        `(assert (= ${READ}${index} ${value}))`,
      );
    }
    const text = [
      ...query.declarations,
      ...query.assertions.map((a) => `(assert ${a})`),
      ...reads,
    ].join("\n");

    const ask = Effect.fn(function* (handle: ReturnType<typeof Z3.mk_solver>) {
      yield* call("z3 rejected a query", text, () => Z3.solver_from_string(context, handle, text));
      const verdict = yield* Effect.tryPromise({
        try: () => Z3.solver_check(context, handle),
        catch: failed("z3 failed"),
      });
      if (Number(verdict) < 0) return { _tag: "Unsat" } as const;
      if (Number(verdict) === 0)
        return {
          _tag: "Unknown",
          reason: yield* call("z3 gave no reason", text, () =>
            Z3.solver_get_reason_unknown(context, handle),
          ),
        } as const;
      const printed = yield* call("z3 gave no model", text, () => {
        const model = Z3.solver_get_model(context, handle);
        Z3.model_inc_ref(context, model);
        const out = Z3.model_to_string(context, model);
        Z3.model_dec_ref(context, model);
        return out;
      });
      const found = new Map<string, number | string | boolean | undefined>();
      for (const item of parse(printed)) {
        if (item._tag !== "List") continue;
        const [head, name, , , value] = item.items;
        if (head?._tag === "Atom" && head.text === "define-fun" && name?._tag === "Atom" && value)
          found.set(bare(name.text), valueOf(value));
      }
      return {
        _tag: "Sat",
        values: query.values.map((_, index) => found.get(`${READ}${index}`)),
      } as const;
    });

    // A solver remembers what it was told to declare, so each query gets its own.
    const answer: Answer = yield* Effect.acquireUseRelease(
      call("z3 failed", text, () => {
        const handle = Z3.mk_solver(context);
        Z3.solver_inc_ref(context, handle);
        return handle;
      }),
      ask,
      (handle) => Effect.sync(() => Z3.solver_dec_ref(context, handle)),
    );
    return answer;
  });
  return { check };
});
