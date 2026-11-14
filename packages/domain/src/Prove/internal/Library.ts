import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import type { Eval, OpticStep, Run, Site, V } from "./Value.ts";
import * as Value from "./Value.ts";

/** What the library models need from the interpreter. */
export interface Host {
  readonly current: { run: Run };
  readonly call: (fn: V, args: ReadonlyArray<V>, site: Site) => Eval<V>;
  /** What `yield*` on the value gives. */
  readonly settle: (value: V, site: Site) => Eval<V>;
  /** The request contexts provided around the code being run, by tag. */
  readonly provided: Map<unknown, V>;
  /** Models a caller adds, by `module:path`. They come before the prover's own. */
  readonly extra: ReadonlyMap<string, Model>;
}

/** What a library function does to symbolic values. */
export type Model = (args: ReadonlyArray<V>, site: Site) => Eval<V>;

/** Milliseconds in a day. */
const DAY = 86_400_000;

const native = (name: string, call: Model): V => ({ _tag: "Native", name, call });
const effect = (run: Eval<V>): V => ({ _tag: "Effect", run });
const done: V = effect(Effect.succeed(Value.undef));

/**
 * The library functions the prover knows, each written once as what it does
 * to a symbolic value. A call to any other library function is not
 * translated, and the report names the call.
 */
export const make = (host: Host) => {
  /** Change the part of `source` an optic focuses on; a focus that misses leaves it as it is. */
  const through = (
    path: ReadonlyArray<OpticStep>,
    source: V,
    change: (focus: V) => Eval<V>,
    site: Site,
  ): Eval<V> => {
    const [step, ...rest] = path;
    if (step === undefined) return change(source);
    if (source._tag !== "Obj")
      return Effect.fail(Value.notTranslated(site, `an optic focuses into a ${source._tag}`));
    if (step._tag === "Tag") {
      const tag = source.fields._tag;
      if (tag?._tag !== "Str")
        return Effect.fail(
          Value.notTranslated(site, "an optic matches a tag the prover cannot see"),
        );
      return tag.value === step.tag ? through(rest, source, change, site) : Effect.succeed(source);
    }
    return through(rest, source.fields[step.key] ?? Value.undef, change, site).pipe(
      Effect.map((changed) => Value.obj({ ...source.fields, [step.key]: changed }, source.brand)),
    );
  };

  const wrongArguments = (site: Site, name: string) =>
    Effect.fail(
      Value.notTranslated(site, `${name} is called in a way the prover has no model for`),
    );

  /** `modify` and `replace`, data-first (`source, optic, x`) or data-last (`optic, x` then `source`). */
  const update =
    (name: string, change: (x: V, site: Site) => (focus: V) => Eval<V>): Model =>
    (args, site) => {
      const [a, b, c] = args;
      if (args.length === 3 && a && b?._tag === "Optic" && c)
        return through(b.path, a, change(c, site), site);
      if (args.length === 2 && a?._tag === "Optic" && b)
        return Effect.succeed(
          native(name, ([source], at) =>
            source ? through(a.path, source, change(b, at), at) : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };

  const modify = update("Optic.modify", (f, site) => (focus) => host.call(f, [focus], site));
  const replace = update("Optic.replace", (value) => () => Effect.succeed(value));

  const str = (v: V | undefined): string | undefined => (v?._tag === "Str" ? v.value : undefined);

  /** The methods of an optic value. */
  const opticMember = (optic: V & { readonly _tag: "Optic" }, key: string): V | undefined => {
    const extend = (make: (name: string) => OpticStep) =>
      native(`optic.${key}`, ([name], site) => {
        const value = str(name);
        return value === undefined
          ? wrongArguments(site, `optic.${key}`)
          : Effect.succeed<V>({ _tag: "Optic", path: [...optic.path, make(value)] });
      });
    switch (key) {
      case "tag":
        return extend((tag) => ({ _tag: "Tag", tag }));
      case "key":
        return extend((key) => ({ _tag: "Key", key }));
      case "modify":
        return native("optic.modify", ([f], site) =>
          f ? modify([optic, f], site) : wrongArguments(site, "optic.modify"),
        );
      case "replace":
        return native("optic.replace", ([value, source], site) =>
          value && source
            ? through(optic.path, source, () => Effect.succeed(value), site)
            : wrongArguments(site, "optic.replace"),
        );
      default:
        return undefined;
    }
  };

  /** `Effect.fn(body)`, `Effect.fn("name")(body)` and `Effect.fn(options)(body)`. */
  const fn: Model = ([first], site) =>
    first?._tag === "Fn"
      ? Effect.succeed<V>({ ...first, effectful: true })
      : first?._tag === "Str" || first?._tag === "Obj"
        ? Effect.succeed(native("Effect.fn", fn))
        : wrongArguments(site, "Effect.fn");

  const ignored: Model = () => Effect.succeed(done);

  /**
   * A function of an effect, called with the effect first (`f(effect, x)`) or
   * later through `pipe` (`f(x)` then the effect).
   */
  const onEffect =
    (
      name: string,
      extra: number,
      run: (self: Eval<V>, args: ReadonlyArray<V>, site: Site) => Eval<V>,
    ): Model =>
    (args, site) => {
      const [first, ...rest] = args;
      if (args.length === extra + 1 && first?._tag === "Effect")
        return Effect.suspend(() => run(first.run, rest, site)).pipe(effect, Effect.succeed);
      if (args.length === extra)
        return Effect.succeed(
          native(name, ([self], at) =>
            self?._tag === "Effect"
              ? Effect.suspend(() => run(self.run, args, at)).pipe(effect, Effect.succeed)
              : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };

  /** What a step after an effect gives: a function of its value, another effect, or a plain value. */
  const then = (next: V, value: V, site: Site): Eval<V> =>
    next._tag === "Effect"
      ? next.run
      : next._tag === "Fn" || next._tag === "Native" || next._tag === "Lib"
        ? host
            .call(next, [value], site)
            .pipe(
              Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
            )
        : Effect.succeed(next);

  const tagsOf = (v: V | undefined): ReadonlyArray<string> | undefined =>
    v?._tag === "Str"
      ? [v.value]
      : v?._tag === "Arr" && v.items.every((item) => item._tag === "Str")
        ? v.items.map((item) => (item as { readonly value: string }).value)
        : undefined;

  const number =
    (
      name: string,
      fold: (a: number, b: number) => number,
      pick: (a: string, b: string) => string,
    ): Model =>
    (args, site) => {
      const [a, b] = args;
      if (args.length !== 2 || !a || !b) return wrongArguments(site, name);
      if (a._tag === "Num" && b._tag === "Num")
        return Effect.succeed(Value.num(fold(a.value, b.value)));
      const left = numeric(a);
      const right = numeric(b);
      if (!left || !right) return wrongArguments(site, name);
      const [x, y] = promote(left, right);
      return Effect.succeed(Value.term(x.sort, pick(x.text, y.text)));
    };

  const models: Readonly<Record<string, Model>> = {
    "effect/Effect:fn": fn,
    "effect/Effect:fnUntraced": fn,
    "effect/Effect:gen": ([body], site) =>
      body?._tag === "Fn"
        ? Effect.suspend(() => host.call({ ...body, effectful: true }, [], site)).pipe(
            Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
            effect,
            Effect.succeed,
          )
        : wrongArguments(site, "Effect.gen"),
    "effect/Effect:succeed": ([value]) =>
      Effect.succeed(value ?? Value.undef).pipe(effect, Effect.succeed),
    "effect/Effect:fail": ([error]) =>
      Effect.fail(new Value.Rejected({ rejection: error ?? Value.undef })).pipe(
        effect,
        Effect.succeed,
      ),
    "effect/Effect:sync": ([thunk], site) =>
      thunk
        ? Effect.suspend(() => host.call(thunk, [], site)).pipe(effect, Effect.succeed)
        : wrongArguments(site, "Effect.sync"),
    "effect/Effect:andThen": onEffect("Effect.andThen", 1, (self, [next], site) =>
      next
        ? self.pipe(Effect.flatMap((value) => then(next, value, site)))
        : wrongArguments(site, "Effect.andThen"),
    ),
    "effect/Effect:flatMap": onEffect("Effect.flatMap", 1, (self, [next], site) =>
      next
        ? self.pipe(Effect.flatMap((value) => then(next, value, site)))
        : wrongArguments(site, "Effect.flatMap"),
    ),
    "effect/Effect:map": onEffect("Effect.map", 1, (self, [f], site) =>
      f
        ? self.pipe(Effect.flatMap((value) => host.call(f, [value], site)))
        : wrongArguments(site, "Effect.map"),
    ),
    "effect/Effect:tap": onEffect("Effect.tap", 1, (self, [next], site) =>
      next
        ? self.pipe(Effect.tap((value) => then(next, value, site)))
        : wrongArguments(site, "Effect.tap"),
    ),
    "effect/Effect:asVoid": onEffect("Effect.asVoid", 0, (self) =>
      self.pipe(Effect.as(Value.undef)),
    ),
    // A rejection the code turns into a defect stops the path the same way.
    "effect/Effect:orDie": onEffect("Effect.orDie", 0, (self) => self),
    "effect/Effect:catchTag": onEffect("Effect.catchTag", 2, (self, [tag, handler], site) => {
      const tags = tagsOf(tag);
      if (!tags || !handler) return wrongArguments(site, "Effect.catchTag");
      return self.pipe(
        Effect.catchTag("Rejected", (rejected) => {
          const thrown = rejected.rejection;
          const name = thrown._tag === "Obj" ? thrown.fields._tag : undefined;
          return name?._tag === "Str" && tags.includes(name.value)
            ? host
                .call(handler, [thrown], site)
                .pipe(Effect.flatMap((made) => host.settle(made, site)))
            : Effect.fail(rejected);
        }),
      );
    }),
    "effect/Effect:provideService": onEffect(
      "Effect.provideService",
      2,
      (self, [tag, value], site) => {
        if (tag?._tag !== "Host" || !value) return wrongArguments(site, "Effect.provideService");
        const before = host.provided.get(tag.value);
        host.provided.set(tag.value, value);
        return self.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (before) host.provided.set(tag.value, before);
              else host.provided.delete(tag.value);
            }),
          ),
        );
      },
    ),
    "effect/Effect:annotateCurrentSpan": ignored,
    "effect/Effect:log": ignored,
    "effect/Effect:logDebug": ignored,
    "effect/Effect:logInfo": ignored,
    "effect/Effect:logWarning": ignored,
    "effect/Effect:logError": ignored,
    "effect/Optic:id": () => Effect.succeed<V>({ _tag: "Optic", path: [] }),
    "effect/Optic:modify": modify,
    "effect/Optic:replace": replace,
    "effect/DateTime:formatIsoDate": ([time], site) => {
      if (time?._tag !== "Time") return wrongArguments(site, "DateTime.formatIsoDate");
      const run = host.current.run;
      // A function of the day, not of the millisecond: the solver then learns
      // one fact per day it tries, instead of one per instant.
      const day = Smt.symbol(`day of ${time.millis.text.replaceAll("|", "")}`);
      if (!run.declarations.has(day)) {
        run.declarations.set(day, `(declare-const ${day} Int)`);
        run.assume(`(= ${day} (div ${time.millis.text} ${DAY}))`);
      }
      return Effect.succeed<V>({
        _tag: "Term",
        term: run.apply(
          "DateTime.formatIsoDate",
          { sort: "Int", text: day },
          "String",
          (at) => DateTime.formatIsoDate(DateTime.makeUnsafe(at * DAY)),
          // "2026-11-10": true of every day, so no day is ever "".
          (date) => `(= (str.len ${date.text}) 10)`,
          // Two days never share a date: the solver cannot invent a day that
          // reads as another, which it would otherwise try one day at a time.
          true,
        ),
      });
    },
    "effect/DateTime:toEpochMillis": ([time], site) =>
      time?._tag === "Time"
        ? Effect.succeed<V>({ _tag: "Term", term: time.millis })
        : wrongArguments(site, "DateTime.toEpochMillis"),
    "Math:max": number("Math.max", Math.max, (a, b) => `(ite (>= ${a} ${b}) ${a} ${b})`),
    "Math:min": number("Math.min", Math.min, (a, b) => `(ite (<= ${a} ${b}) ${a} ${b})`),
  };

  /** Library values that are not functions. */
  const values: Readonly<Record<string, V>> = {
    "effect/Effect:void": done,
  };

  const keyOf = (lib: V & { readonly _tag: "Lib" }): string =>
    `${lib.module}:${lib.path.join(".")}`;

  return {
    opticMember,
    valueOf: (lib: V & { readonly _tag: "Lib" }): V | undefined => values[keyOf(lib)],
    call: (lib: V & { readonly _tag: "Lib" }, args: ReadonlyArray<V>, site: Site): Eval<V> => {
      const model = host.extra.get(keyOf(lib)) ?? models[keyOf(lib)];
      if (model) return model(args, site);
      // A schema is built, never run: what it describes is read where it is used.
      if (lib.module === "effect/Schema")
        return Effect.succeed<V>({ _tag: "Opaque", what: "a schema" });
      return Effect.fail(
        Value.notTranslated(
          site,
          `calls ${lib.module.replace(/^effect\//, "")}.${lib.path.join(".")}, which the prover has no model for`,
        ),
      );
    },
  };
};

/** A number as a solver term, or `undefined` when the value is not a number. */
export const numeric = (v: V): Term | undefined =>
  v._tag === "Num"
    ? Number.isFinite(v.value)
      ? Number.isInteger(v.value)
        ? Smt.int(v.value)
        : Smt.real(v.value)
      : undefined
    : v._tag === "Term" && (v.term.sort === "Int" || v.term.sort === "Real")
      ? v.term
      : undefined;

const toReal = (term: Term): Term =>
  term.sort === "Int" ? { sort: "Real", text: `(to_real ${term.text})` } : term;

/** Two numbers in one sort: an integer next to a real becomes a real. */
export const promote = (a: Term, b: Term): readonly [Term, Term] =>
  a.sort === b.sort ? [a, b] : [toReal(a), toReal(b)];
