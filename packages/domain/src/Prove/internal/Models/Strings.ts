import * as Effect from "effect/Effect";
import * as Compare from "../Compare.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, dual, native, wholeOf, wrongArguments } from "../Kit.ts";
import type { Term } from "../Smt.ts";
import * as Smt from "../Smt.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

/** What a string's method does, given the string and the arguments. */
type Method = (self: V, args: ReadonlyArray<V>, site: Site) => Eval<V>;

const known = (v: V | undefined): string | undefined => (v?._tag === "Str" ? v.value : undefined);
const index = (v: V | undefined): number | undefined =>
  v?._tag === "Num" && Number.isInteger(v.value) ? v.value : undefined;
const absent = (v: V | undefined): boolean => v === undefined || v._tag === "Undef";

/**
 * Strings: the methods of a string, and `effect/String`, which is the same
 * methods as functions. A string the prover knows is computed as JavaScript
 * computes it; one an input holds is the solver's, which knows what a string
 * starts with, ends with and holds, how long it is, and parts of it.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  const unread = (site: Site, name: string): Eval<never> =>
    Effect.fail(
      Value.notTranslated(
        site,
        `calls ${name} on a string an input holds, in a way the prover does not translate`,
      ),
    );

  /** A method the prover computes only on a string, and arguments, it knows. */
  const computed =
    (name: string, run: (self: string, args: ReadonlyArray<unknown>) => unknown): Method =>
    (self, args, site) => {
      const text = known(self);
      const given = args.map((arg) =>
        arg._tag === "Str" || arg._tag === "Num" || arg._tag === "Bool"
          ? { value: arg.value as unknown }
          : arg._tag === "Undef"
            ? { value: undefined as unknown }
            : undefined,
      );
      if (text === undefined || given.some((arg) => arg === undefined)) return unread(site, name);
      // A method that throws on what it is given stops the code: nothing is read past it.
      let made: unknown;
      try {
        made = run(
          text,
          given.map((arg) => arg!.value),
        );
      } catch (cause) {
        return Effect.fail(
          Value.notTranslated(site, `calls ${name}, which throws: ${String(cause)}`),
        );
      }
      return typeof made === "string"
        ? Effect.succeed(Value.str(made))
        : typeof made === "number"
          ? Effect.succeed(Value.num(made))
          : typeof made === "boolean"
            ? Effect.succeed(Value.bool(made))
            : Array.isArray(made)
              ? Effect.succeed(arr(made.map((part) => Value.str(String(part)))))
              : made === undefined
                ? Effect.succeed(Value.undef)
                : unread(site, name);
    };

  /** A test of one string against another: `startsWith`, `endsWith`, `includes`. */
  const test =
    (
      name: string,
      fold: (self: string, other: string) => boolean,
      formula: (self: string, other: string) => string,
    ): Method =>
    (self, [other, position], site) => {
      const a = Compare.textual(self);
      const b = other ? Compare.textual(other) : undefined;
      if (!a || !b || !absent(position)) return unread(site, name);
      const x = known(self);
      const y = known(other);
      return Effect.succeed(
        x !== undefined && y !== undefined
          ? Value.bool(fold(x, y))
          : Value.term("Bool", formula(a.text, b.text)),
      );
    };

  const part = (self: V, from: number, to: number | undefined, name: string, site: Site) => {
    const text = Compare.textual(self);
    if (!text || from < 0 || (to !== undefined && to < 0)) return unread(site, name);
    const length =
      to === undefined ? `(- (str.len ${text.text}) ${from})` : `${Math.max(0, to - from)}`;
    return Effect.succeed(Value.term("String", `(str.substr ${text.text} ${from} ${length})`));
  };

  /** A string an input holds, cut at the first or the last place a separator the code writes is. */
  interface Cut {
    readonly self: string;
    readonly separator: string;
    /** Whether the separator is there. */
    readonly found: string;
    /** What is before it and what is after it, when it is there. */
    readonly before: string;
    readonly after: string;
    /** Where it is, as `indexOf` and `lastIndexOf` give it: `-1` when it is not there. */
    readonly index: string;
  }

  // Each cut by the formula for where it is: `slice` at that place is the part before, or after.
  const cuts = new Map<string, Cut>();

  /**
   * Cut a string at a separator. The solver is told what the cut means, a
   * string before, the separator and a string after, with no separator
   * sooner (or later), which it does not work out from a position alone.
   */
  const cut = (self: string, separator: string, which: "first" | "last"): Cut => {
    const run = host.current.run;
    const sep = Smt.string(separator).text;
    const name = (part: string) =>
      Smt.symbol(`${part} the ${which} ${JSON.stringify(separator)} of ${self}`);
    const before = name("before");
    const after = name("after");
    const found = `(str.contains ${self} ${sep})`;
    if (!run.declarations.has(before)) {
      run.declarations.set(before, `(declare-const ${before} String)`);
      run.declarations.set(after, `(declare-const ${after} String)`);
      const only =
        which === "first"
          ? `(not (str.contains (str.++ ${before} ${Smt.string(separator.slice(0, -1)).text}) ${sep}))`
          : `(not (str.contains (str.++ ${Smt.string(separator.slice(1)).text} ${after}) ${sep}))`;
      run.assume(`(=> ${found} (and (= ${self} (str.++ ${before} ${sep} ${after})) ${only}))`);
      // The first is never after the last, and where they are one place, the separator is there once.
      const other = (part: string) =>
        Smt.symbol(
          `${part} the ${which === "first" ? "last" : "first"} ${JSON.stringify(separator)} of ${self}`,
        );
      if (run.declarations.has(other("before"))) {
        const [firstBefore, lastBefore] =
          which === "first" ? [before, other("before")] : [other("before"), before];
        run.assume(
          `(=> ${found} (and (<= (str.len ${firstBefore}) (str.len ${lastBefore})) (=> (= (str.len ${firstBefore}) (str.len ${lastBefore})) (and (= ${after} ${other("after")}) (not (str.contains ${after} ${sep})) (not (str.contains ${before} ${sep}))))))`,
        );
      }
    }
    const index = `(ite ${found} (str.len ${before}) (- 1))`;
    const made: Cut = { self, separator, found, before, after, index };
    cuts.set(index, made);
    return made;
  };

  /** Where a separator the code writes is in a string an input holds: `undefined` for any other call. */
  const place = (
    self: V,
    wanted: V | undefined,
    position: V | undefined,
    which: "first" | "last",
  ): V | undefined => {
    const separator = known(wanted);
    if (self._tag !== "Term" || self.term.sort !== "String" || !absent(position)) return undefined;
    if (separator === undefined) return undefined;
    // An empty string is found at once: at the start, or at the end.
    if (separator === "")
      return which === "first" ? Value.num(0) : Value.term("Int", `(str.len ${self.term.text})`);
    return Value.term("Int", cut(self.term.text, separator, which).index);
  };

  /** A place in a string as `slice` reads it: counted from the end when negative, and never past either end. */
  const clamped = (text: string, at: number | Term): string => {
    const length = `(str.len ${text})`;
    if (typeof at === "number")
      return at >= 0
        ? `(ite (< ${at} ${length}) ${at} ${length})`
        : `(ite (< (+ ${length} ${Smt.int(at).text}) 0) 0 (+ ${length} ${Smt.int(at).text}))`;
    return `(ite (< ${at.text} 0) (ite (< (+ ${length} ${at.text}) 0) 0 (+ ${length} ${at.text})) (ite (< ${at.text} ${length}) ${at.text} ${length}))`;
  };

  /** `slice` of a string an input holds, at places that may depend on an input. */
  const sliced = (self: Term, from: number | Term, to: number | Term | undefined): V => {
    const text = self.text;
    // `s.slice(0, s.indexOf(sep))`: what is before the separator. With none, `-1` drops the last character.
    const upTo = from === 0 && typeof to === "object" ? cuts.get(to.text) : undefined;
    if (upTo && upTo.self === text)
      return Value.term(
        "String",
        `(ite ${upTo.found} ${upTo.before} (str.substr ${text} 0 (- (str.len ${text}) 1)))`,
      );
    // `s.slice(s.indexOf(sep) + sep.length)`: what is after the separator.
    if (typeof from === "object" && to === undefined)
      for (const found of cuts.values()) {
        const size = found.separator.length;
        if (
          found.self === text &&
          (from.text === `(+ ${found.index} ${size})` || from.text === `(+ ${size} ${found.index})`)
        )
          return Value.term(
            "String",
            `(ite ${found.found} ${found.after} (str.substr ${text} ${size - 1} (str.len ${text})))`,
          );
      }
    const start = from === 0 ? "0" : clamped(text, from);
    const end = to === undefined ? `(str.len ${text})` : clamped(text, to);
    return Value.term("String", `(str.substr ${text} ${start} (- ${end} ${start}))`);
  };

  /** Whether a separator can start again before it ends: `::` in `:::`, `aba` in `ababa`. */
  const overlaps = (separator: string): boolean =>
    Array.from({ length: separator.length - 1 }, (_, index) => index + 1).some(
      (size) => separator.slice(0, size) === separator.slice(-size),
    );

  /** The most separators the prover gives a split string whose parts the code counts. */
  const MAX_CUTS = 2;

  /** `split` of a string an input holds, by a separator the code writes. */
  const splitting = (self: V & { readonly _tag: "Term" }, separator: string): V => {
    const text = self.term.text;
    const sep = Smt.string(separator).text;
    const first = cut(text, separator, "first");
    const last = cut(text, separator, "last");
    const name = `${text.replace(/^\|(.*)\|$/, "$1")}.split(${JSON.stringify(separator)})`;
    return {
      _tag: "List",
      name,
      ast: undefined,
      split: {
        self,
        separator,
        first: Value.term("String", `(ite ${first.found} ${first.before} ${text})`),
        // A separator that overlaps itself, as `::` does in `:::`, is cut from the left: the last part is counted.
        ...(overlaps(separator)
          ? {}
          : { last: Value.term("String", `(ite ${last.found} ${last.after} ${text})`) }),
        parts: (run) => {
          // The parts are counted: the run takes each number of separators in turn, up to a few.
          run.bounds.set(name, MAX_CUTS + 1);
          const count = run.choose(MAX_CUTS + 1);
          const parts: Array<string> = [];
          for (let index = 0; index <= count; index++) {
            parts.push(run.constant(`part ${index + 1} of ${count + 1} of ${name}`, "String").text);
          }
          const head = Smt.string(separator.slice(0, -1)).text;
          run.assume(
            `(= ${text} ${parts.length === 1 ? parts[0]! : `(str.++ ${parts.join(` ${sep} `)})`})`,
          );
          // No part holds the separator, and none ends where one starts sooner than the one that cut it.
          for (const [index, part] of parts.entries())
            run.assume(
              index < count
                ? `(not (str.contains (str.++ ${part} ${head}) ${sep}))`
                : `(not (str.contains ${part} ${sep}))`,
            );
          return arr(parts.map((part) => Value.term("String", part)));
        },
      },
    };
  };

  const methods: Readonly<Record<string, Method>> = {
    startsWith: test(
      "startsWith",
      (a, b) => a.startsWith(b),
      (a, b) => `(str.prefixof ${b} ${a})`,
    ),
    endsWith: test(
      "endsWith",
      (a, b) => a.endsWith(b),
      (a, b) => `(str.suffixof ${b} ${a})`,
    ),
    includes: test(
      "includes",
      (a, b) => a.includes(b),
      (a, b) => `(str.contains ${a} ${b})`,
    ),
    concat: Effect.fnUntraced(function* (self: V, args: ReadonlyArray<V>, site: Site) {
      let out = self;
      for (const arg of args) {
        if (!Compare.textual(arg)) return yield* unread(site, "concat");
        out = yield* host.arithmetic("+", out, arg, site);
      }
      return out;
    }),
    slice: (self, [from, to], site) => {
      const text = known(self);
      const a = absent(from) ? 0 : index(from);
      const b = absent(to) ? undefined : index(to);
      if (a !== undefined && (absent(to) || b !== undefined)) {
        if (text !== undefined) return Effect.succeed(Value.str(text.slice(a, b)));
        if (a >= 0 && (b === undefined || b >= 0)) return part(self, a, b, "slice", site);
      }
      // A place an input decides: where a separator is, or a number the command holds.
      const start = absent(from) ? 0 : wholeOf(from);
      const end = absent(to) ? undefined : wholeOf(to);
      const term = Compare.textual(self);
      return term && start !== undefined && (absent(to) || end !== undefined)
        ? Effect.succeed(sliced(term, start, end))
        : unread(site, "slice");
    },
    substring: (self, [from, to], site) => {
      const text = known(self);
      const a = absent(from) ? 0 : index(from);
      const b = absent(to) ? undefined : index(to);
      if (a !== undefined && (absent(to) || b !== undefined)) {
        if (text !== undefined) return Effect.succeed(Value.str(text.substring(a, b)));
        // `substring` swaps its bounds when the first is the larger.
        if (a >= 0 && (b === undefined || b >= a)) return part(self, a, b, "substring", site);
      }
      const start = absent(from) ? 0 : wholeOf(from);
      const end = absent(to) ? undefined : wholeOf(to);
      const term = Compare.textual(self);
      if (!term || start === undefined || (!absent(to) && end === undefined))
        return unread(site, "substring");
      // `s.substring(0, s.indexOf(sep))`: what is before the separator, and nothing with none.
      const upTo = start === 0 && typeof end === "object" ? cuts.get(end.text) : undefined;
      if (upTo && upTo.self === term.text)
        return Effect.succeed(Value.term("String", `(ite ${upTo.found} ${upTo.before} "")`));
      // A place below zero is the start, one past the end is the end, and the smaller of the two comes first.
      const length = `(str.len ${term.text})`;
      const within = (at: number | Term): string => {
        const n = typeof at === "number" ? Smt.int(at).text : at.text;
        return `(ite (< ${n} 0) 0 (ite (< ${n} ${length}) ${n} ${length}))`;
      };
      const low = within(start);
      const high = end === undefined ? length : within(end);
      return Effect.succeed(
        Value.term(
          "String",
          `(ite (<= ${low} ${high}) (str.substr ${term.text} ${low} (- ${high} ${low})) (str.substr ${term.text} ${high} (- ${low} ${high})))`,
        ),
      );
    },
    charAt: (self, [at], site) => {
      const text = known(self);
      const i = absent(at) ? 0 : index(at);
      if (i === undefined) return unread(site, "charAt");
      if (text !== undefined) return Effect.succeed(Value.str(text.charAt(i)));
      const term = Compare.textual(self);
      return term && i >= 0
        ? Effect.succeed(Value.term("String", `(str.at ${term.text} ${i})`))
        : unread(site, "charAt");
    },
    indexOf: (self, [wanted, position], site) => {
      const placed = place(self, wanted, position, "first");
      if (placed) return Effect.succeed(placed);
      const a = Compare.textual(self);
      const b = wanted ? Compare.textual(wanted) : undefined;
      if (!a || !b || !absent(position)) return unread(site, "indexOf");
      const x = known(self);
      const y = known(wanted);
      return Effect.succeed(
        x !== undefined && y !== undefined
          ? Value.num(x.indexOf(y))
          : Value.term("Int", `(str.indexof ${a.text} ${b.text} 0)`),
      );
    },
    // A string is replaced by a string the code writes: a `$` in it would stand for part of what was found.
    replace: (self, [pattern, replacement], site) => {
      const a = Compare.textual(self);
      const b = pattern ? Compare.textual(pattern) : undefined;
      const with_ = known(replacement);
      if (!a || !b || with_ === undefined || with_.includes("$")) return unread(site, "replace");
      const x = known(self);
      const y = known(pattern);
      return Effect.succeed(
        x !== undefined && y !== undefined
          ? Value.str(x.replace(y, with_))
          : Value.term("String", `(str.replace ${a.text} ${b.text} ${Smt.string(with_).text})`),
      );
    },
    replaceAll: (self, [pattern, replacement], site) => {
      const a = Compare.textual(self);
      const y = known(pattern);
      const with_ = known(replacement);
      if (!a || y === undefined || y === "" || with_ === undefined || with_.includes("$"))
        return unread(site, "replaceAll");
      const x = known(self);
      return Effect.succeed(
        x !== undefined
          ? Value.str(x.replaceAll(y, with_))
          : Value.term(
              "String",
              `(str.replace_all ${a.text} ${Smt.string(y).text} ${Smt.string(with_).text})`,
            ),
      );
    },
    at: computed("at", (self, [i]) => self.at(Number(i ?? 0))),
    toUpperCase: computed("toUpperCase", (self) => self.toUpperCase()),
    toLowerCase: computed("toLowerCase", (self) => self.toLowerCase()),
    trim: computed("trim", (self) => self.trim()),
    trimStart: computed("trimStart", (self) => self.trimStart()),
    trimEnd: computed("trimEnd", (self) => self.trimEnd()),
    padStart: computed("padStart", (self, [n, fill]) =>
      self.padStart(Number(n), fill as string | undefined),
    ),
    padEnd: computed("padEnd", (self, [n, fill]) =>
      self.padEnd(Number(n), fill as string | undefined),
    ),
    repeat: computed("repeat", (self, [n]) => self.repeat(Number(n))),
    split: (self, args, site) => {
      const separator = known(args[0]);
      return self._tag === "Term" &&
        self.term.sort === "String" &&
        separator !== undefined &&
        separator !== "" &&
        absent(args[1])
        ? Effect.succeed(splitting(self, separator))
        : splitKnown(self, args, site);
    },
    lastIndexOf: (self, args, site) => {
      const placed = place(self, args[0], args[1], "last");
      return placed ? Effect.succeed(placed) : lastIndexKnown(self, args, site);
    },
    charCodeAt: computed("charCodeAt", (self, [i]) => self.charCodeAt(Number(i ?? 0))),
  };

  const splitKnown = computed("split", (self, [separator]) =>
    typeof separator === "string" ? self.split(separator) : [self],
  );
  const lastIndexKnown = computed("lastIndexOf", (self, [wanted]) =>
    self.lastIndexOf(String(wanted)),
  );

  /** A method of a string, as a value the code calls: `undefined` when the prover has none by that name. */
  const member = (self: V, key: string): V | undefined => {
    const method = Object.hasOwn(methods, key) ? methods[key] : undefined;
    return method && native(key, (args, site) => method(self, args, site));
  };

  /** `String.startsWith(prefix)(self)`: the arguments first, then the string. */
  const curried =
    (name: string, key: string = name): Model =>
    (args) =>
      Effect.succeed(
        native(`String.${name}`, ([self], site) =>
          self && Compare.textual(self)
            ? methods[key]!(self, args, site)
            : wrongArguments(site, `String.${name}`),
        ),
      );

  /** `String.trim(self)`: the string itself. */
  const direct =
    (name: string, key: string = name): Model =>
    ([self], site) =>
      self && Compare.textual(self)
        ? methods[key]!(self, [], site)
        : wrongArguments(site, `String.${name}`);

  const length = (self: V | undefined, site: Site): Eval<V> => {
    const text = self ? Compare.textual(self) : undefined;
    if (!self || !text) return wrongArguments(site, "String.length");
    return Effect.succeed(
      self._tag === "Str"
        ? Value.num(self.value.length)
        : Value.term("Int", `(str.len ${text.text})`),
    );
  };

  /** A place in a string, as an `Option`: nothing where the method gives `""`, `undefined` or `-1`. */
  const placed = (
    name: string,
    key: string,
    nothing: V,
    self: V | undefined,
    args: ReadonlyArray<V>,
    site: Site,
  ): Eval<V> =>
    self && Compare.textual(self)
      ? Effect.gen(function* () {
          const made = yield* methods[key]!(self, args, site);
          const missing = yield* host.decide(yield* host.equal(made, nothing, site), site);
          return missing ? Value.none : Value.some(made);
        })
      : wrongArguments(site, `String.${name}`);

  /** `String.indexOf(needle)(self)`: the string is always given second. */
  const optional =
    (name: string, key: string, nothing: V): Model =>
    (args) =>
      Effect.succeed(
        native(`String.${name}`, ([self], site) => placed(name, key, nothing, self, args, site)),
      );

  /** `String.at(self, index)`, or `String.at(index)` then the string. */
  const optionalDual = (name: string, key: string, nothing: V): Model =>
    dual(`String.${name}`, 2, ([self, ...args], site) =>
      placed(name, key, nothing, self, args, site),
    );

  const first = (text: string, change: (head: string) => string): string =>
    text === "" ? text : change(text[0]!) + text.slice(1);

  const models: Models = {
    "effect/String:isString": ([value], site) => {
      const kind = value ? host.kind(value) : undefined;
      return kind === undefined
        ? wrongArguments(site, "String.isString")
        : Effect.succeed(Value.bool(kind === "string"));
    },
    "effect/String:length": ([self], site) => length(self, site),
    "effect/String:isEmpty": ([self], site) =>
      Effect.flatMap(length(self, site), (size) => host.equal(size, Value.num(0), site)),
    "effect/String:isNonEmpty": ([self], site) =>
      Effect.flatMap(length(self, site), (size) => host.arithmetic(">", size, Value.num(0), site)),
    "effect/String:concat": dual("String.concat", 2, ([self, that], site) =>
      self && that ? methods.concat!(self, [that], site) : wrongArguments(site, "String.concat"),
    ),
    "effect/String:startsWith": curried("startsWith"),
    "effect/String:endsWith": curried("endsWith"),
    "effect/String:includes": curried("includes"),
    "effect/String:slice": curried("slice"),
    "effect/String:substring": curried("substring"),
    "effect/String:replace": curried("replace"),
    "effect/String:replaceAll": curried("replaceAll"),
    "effect/String:padStart": curried("padStart"),
    "effect/String:padEnd": curried("padEnd"),
    "effect/String:repeat": curried("repeat"),
    "effect/String:split": dual("String.split", 2, ([self, separator], site) =>
      self && separator
        ? methods.split!(self, [separator], site)
        : wrongArguments(site, "String.split"),
    ),
    "effect/String:takeLeft": dual("String.takeLeft", 2, ([self, n], site) =>
      self && n?._tag === "Num"
        ? methods.slice!(self, [Value.num(0), Value.num(Math.max(0, n.value))], site)
        : wrongArguments(site, "String.takeLeft"),
    ),
    "effect/String:takeRight": dual("String.takeRight", 2, (args, site) => takeRight(args, site)),
    "effect/String:charAt": optionalDual("charAt", "charAt", Value.str("")),
    "effect/String:at": optionalDual("at", "at", Value.undef),
    "effect/String:indexOf": optional("indexOf", "indexOf", Value.num(-1)),
    "effect/String:lastIndexOf": optional("lastIndexOf", "lastIndexOf", Value.num(-1)),
    "effect/String:trim": direct("trim"),
    "effect/String:trimStart": direct("trimStart"),
    "effect/String:trimEnd": direct("trimEnd"),
    "effect/String:toUpperCase": direct("toUpperCase"),
    "effect/String:toLowerCase": direct("toLowerCase"),
    "effect/String:capitalize": computedModel("String.capitalize", (self) =>
      first(self, (head) => head.toUpperCase()),
    ),
    "effect/String:uncapitalize": computedModel("String.uncapitalize", (self) =>
      first(self, (head) => head.toLowerCase()),
    ),
  };

  const takeRight = computedModel("String.takeRight", (self, [n]) =>
    self.slice(Math.max(0, self.length - Math.max(0, Number(n)))),
  );

  /** A function of a string, and arguments, the prover knows. */
  function computedModel(
    name: string,
    run: (self: string, args: ReadonlyArray<unknown>) => unknown,
  ): Model {
    const method = computed(name, run);
    return ([self, ...rest], site) =>
      self ? method(self, rest, site) : wrongArguments(site, name);
  }

  const values: Record<string, V> = { "effect/String:empty": Value.str("") };

  return { models, values, member, names: Object.keys(methods) };
};
