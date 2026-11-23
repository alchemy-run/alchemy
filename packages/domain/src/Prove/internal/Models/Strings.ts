import * as Effect from "effect/Effect";
import * as Compare from "../Compare.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, dual, native, wrongArguments } from "../Kit.ts";
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
      const made = run(
        text,
        given.map((arg) => arg!.value),
      );
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
      if (a === undefined || (!absent(to) && b === undefined)) return unread(site, "slice");
      return text !== undefined
        ? Effect.succeed(Value.str(text.slice(a, b)))
        : part(self, a, b, "slice", site);
    },
    substring: (self, [from, to], site) => {
      const text = known(self);
      const a = absent(from) ? 0 : index(from);
      const b = absent(to) ? undefined : index(to);
      if (a === undefined || (!absent(to) && b === undefined)) return unread(site, "substring");
      if (text !== undefined) return Effect.succeed(Value.str(text.substring(a, b)));
      // `substring` swaps its bounds when the first is the larger.
      return b !== undefined && b < a
        ? unread(site, "substring")
        : part(self, a, b, "substring", site);
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
    split: computed("split", (self, [separator]) =>
      typeof separator === "string" ? self.split(separator) : [self],
    ),
    lastIndexOf: computed("lastIndexOf", (self, [wanted]) => self.lastIndexOf(String(wanted))),
    charCodeAt: computed("charCodeAt", (self, [i]) => self.charCodeAt(Number(i ?? 0))),
  };

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
  const optional =
    (name: string, key: string, nothing: V): Model =>
    (args) =>
      Effect.succeed(
        native(`String.${name}`, ([self], site) =>
          self && Compare.textual(self)
            ? Effect.gen(function* () {
                const made = yield* methods[key]!(self, args, site);
                const missing = yield* host.decide(yield* host.equal(made, nothing, site), site);
                return missing ? Value.none : Value.some(made);
              })
            : wrongArguments(site, `String.${name}`),
        ),
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
    "effect/String:charAt": optional("charAt", "charAt", Value.str("")),
    "effect/String:at": optional("at", "at", Value.undef),
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

  return { models, values, member };
};
