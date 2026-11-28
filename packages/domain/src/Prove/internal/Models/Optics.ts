import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, native, str, wrongArguments } from "../Kit.ts";
import type { Eval, OpticKind, OpticStep, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

type Optic = V & { readonly _tag: "Optic" };
type Got = Value.OpticGot;

const FOUND = (value: V): Got => ({ ok: true, value });
const MISSED: Got = { ok: false };

/** What the library's optics have for a focus that is not there: a schema issue, which the prover does not look inside. */
const ISSUE: V = { _tag: "Opaque", what: "the schema issue of an optic that found nothing" };

/** The kind of two optics, one after the other, as the library works it out. */
const composeKind = (a: OpticKind, b: OpticKind): OpticKind =>
  a === "Iso" ? b : b === "Iso" || a === b ? a : "Optional";
const kindOf = (path: ReadonlyArray<OpticStep>): OpticKind =>
  path.reduce<OpticKind>((kind, step) => composeKind(kind, step.kind), "Iso");
/** A Prism and an Optional may not find their focus. */
const mayMiss = (kind: OpticKind): boolean => kind === "Prism" || kind === "Optional";
/** An Iso and a Prism make a whole value of a focus, without the one it came from. */
const sourceFree = (kind: OpticKind): boolean => kind === "Iso" || kind === "Prism";

/**
 * `effect/Optic`: a focus inside a value, read and replaced as the library
 * does it. An optic is a list of steps, each an Iso, a Lens, a Prism or an
 * Optional; what they make together, and how a value is put back, follow the
 * library's own rules for each kind.
 */
export const make = (kit: Kit) => {
  const { host } = kit;
  const optic = (path: ReadonlyArray<OpticStep>): Optic => ({ _tag: "Optic", path });
  const isOptic = (v: V | undefined): v is Optic => v?._tag === "Optic";
  const unseen = (site: Site, what: string): Eval<never> =>
    Effect.fail(Value.notTranslated(site, what));

  /** What every step finds, one inside another. */
  const found = (path: ReadonlyArray<OpticStep>, source: V, site: Site): Eval<Got> =>
    Effect.gen(function* () {
      let at = source;
      for (const step of path) {
        const got = yield* step.get(at, site);
        if (!got.ok) return MISSED;
        at = got.value;
      }
      return FOUND(at);
    });

  /**
   * A value with the focus replaced: nothing where a step cannot put it back.
   * An optic of one step puts it back as that step does; one of several first
   * finds every part on the way down, as the library does.
   */
  const replaced = (path: ReadonlyArray<OpticStep>, value: V, source: V, site: Site): Eval<Got> =>
    Effect.gen(function* () {
      if (path.length === 1) return yield* path[0]!.set(value, source, site);
      if (sourceFree(kindOf(path))) {
        let made = value;
        for (const step of path.toReversed()) {
          const put = yield* step.set(made, Value.undef, site);
          if (!put.ok) return MISSED;
          made = put.value;
        }
        return FOUND(made);
      }
      const sources: Array<V> = [];
      let at = source;
      for (const step of path) {
        sources.push(at);
        const got = yield* step.get(at, site);
        if (!got.ok) return MISSED;
        at = got.value;
      }
      let made = value;
      for (const [index, step] of [...path.entries()].toReversed()) {
        const put = yield* step.set(made, sources[index]!, site);
        if (!put.ok) return MISSED;
        made = put.value;
      }
      return FOUND(made);
    });

  const asResult = (got: Got): V => (got.ok ? Brands.success(got.value) : Brands.failure(ISSUE));

  // ---- What an optic does to a value.

  const get = (path: ReadonlyArray<OpticStep>, source: V, site: Site): Eval<V> =>
    mayMiss(kindOf(path))
      ? unseen(site, "reads Optic.get of an optic that may not find its focus")
      : Effect.map(found(path, source, site), (got) => (got.ok ? got.value : Value.undef));
  const getResult = (path: ReadonlyArray<OpticStep>, source: V, site: Site): Eval<V> =>
    Effect.map(found(path, source, site), asResult);
  const replaceResult = (path: ReadonlyArray<OpticStep>, value: V, source: V, site: Site) =>
    Effect.map(replaced(path, value, source, site), asResult);
  const replace = (path: ReadonlyArray<OpticStep>, value: V, source: V, site: Site): Eval<V> =>
    Effect.map(replaced(path, value, source, site), (got) => (got.ok ? got.value : source));
  const modify = (path: ReadonlyArray<OpticStep>, f: V, source: V, site: Site): Eval<V> =>
    Effect.flatMap(found(path, source, site), (got) =>
      got.ok
        ? Effect.flatMap(host.call(f, [got.value], site), (changed) =>
            replace(path, changed, source, site),
          )
        : Effect.succeed(source),
    );
  const set = (path: ReadonlyArray<OpticStep>, value: V, site: Site): Eval<V> =>
    sourceFree(kindOf(path))
      ? Effect.map(replaced(path, value, Value.undef, site), (got) =>
          got.ok ? got.value : Value.undef,
        )
      : unseen(site, "calls Optic.set of an optic that needs the value it replaces in");

  // ---- Steps.

  const fieldsOf = (source: V, site: Site, name: string): Eval<Record<string, V>> =>
    source._tag === "Obj"
      ? Effect.succeed(source.fields as Record<string, V>)
      : unseen(site, `${name} focuses into a ${source._tag}`);
  const withField = (source: V, key: string, value: V | undefined): V => {
    if (source._tag !== "Obj") return source;
    const fields: Record<string, V> = { ...source.fields };
    if (value === undefined) delete fields[key];
    else fields[key] = value;
    return Value.obj(fields, source.brand);
  };
  const decided = (test: Eval<V>, site: Site): Eval<boolean> =>
    Effect.flatMap(test, (v) => host.decide(v, site));
  const result = (name: string, made: V, site: Site): Eval<Got> => {
    const read = Brands.resultOf(made);
    if (!read) return wrongArguments(site, name);
    return Effect.succeed(read._tag === "Success" ? FOUND(read.success) : MISSED);
  };

  const keyStep = (key: string): OpticStep => ({
    kind: "Lens",
    get: (source, site) =>
      Effect.flatMap(fieldsOf(source, site, `.key("${key}")`), () =>
        Effect.map(host.member(source, key, site), FOUND),
      ),
    set: (value, source, site) =>
      Effect.map(fieldsOf(source, site, `.key("${key}")`), () =>
        FOUND(withField(source, key, value)),
      ),
  });
  const optionalKeyStep = (key: string): OpticStep => ({
    kind: "Lens",
    get: (source, site) =>
      Effect.map(fieldsOf(source, site, `.optionalKey("${key}")`), (fields) =>
        FOUND(fields[key] ?? Value.undef),
      ),
    set: (value, source, site) =>
      Effect.map(fieldsOf(source, site, `.optionalKey("${key}")`), () =>
        FOUND(withField(source, key, value._tag === "Undef" ? undefined : value)),
      ),
  });
  const atStep = (key: string): OpticStep => ({
    kind: "Optional",
    get: (source, site) =>
      Effect.map(fieldsOf(source, site, `.at("${key}")`), (fields) =>
        Object.hasOwn(fields, key) ? FOUND(fields[key]!) : MISSED,
      ),
    set: (value, source, site) =>
      Effect.map(fieldsOf(source, site, `.at("${key}")`), (fields) =>
        Object.hasOwn(fields, key) ? FOUND(withField(source, key, value)) : MISSED,
      ),
  });
  /** A focus that is the value itself, where a test of it holds: `.tag`, `.refine`, `.notUndefined`. */
  const refineStep = (holds: (source: V, site: Site) => Eval<boolean>): OpticStep => ({
    kind: "Prism",
    get: (source, site) => Effect.map(holds(source, site), (ok) => (ok ? FOUND(source) : MISSED)),
    set: (value) => Effect.succeed(FOUND(value)),
  });
  const tagStep = (tag: string): OpticStep =>
    refineStep((source, site) => {
      const seen = source._tag === "Obj" ? source.fields._tag : undefined;
      if (seen === undefined) return Effect.succeed(false);
      if (seen._tag === "Str") return Effect.succeed(seen.value === tag);
      return decided(host.equal(seen, Value.str(tag), site), site);
    });
  const notUndefinedStep = refineStep((source, site) =>
    source._tag === "Undef"
      ? Effect.succeed(false)
      : host.kind(source) !== undefined
        ? Effect.succeed(true)
        : unseen(site, "asks whether a value an input decides is undefined"),
  );
  /** A step written by the code's functions. */
  const madeStep = (
    kind: OpticKind,
    name: string,
    getter: V,
    setter: V,
    reads: "value" | "result",
    puts: "value" | "result",
  ): OpticStep => ({
    kind,
    get: (source, site) =>
      Effect.flatMap(host.call(getter, [source], site), (made) =>
        reads === "value" ? Effect.succeed(FOUND(made)) : result(name, made, site),
      ),
    set: (value, source, site) =>
      Effect.flatMap(
        host.call(setter, sourceFree(kind) ? [value] : [value, source], site),
        (made) => (puts === "value" ? Effect.succeed(FOUND(made)) : result(name, made, site)),
      ),
  });
  /** A Prism onto what an `Option` or a `Result` holds. */
  const branchStep = (read: (source: V) => Got, build: (value: V) => V): OpticStep => ({
    kind: "Prism",
    get: (source) => Effect.succeed(read(source)),
    set: (value) => Effect.succeed(FOUND(build(value))),
  });
  const entriesStep: OpticStep = {
    kind: "Iso",
    get: (source, site) =>
      source._tag === "Obj" && !source.brand
        ? Effect.succeed(
            FOUND(
              arr(
                Object.entries(source.fields)
                  .filter(([, value]) => value._tag !== "Undef")
                  .map(([key, value]) => arr([Value.str(key), value])),
              ),
            ),
          )
        : unseen(site, "reads Optic.entries of a value that is not a record"),
    set: (value, _, site) =>
      Effect.gen(function* () {
        const fields: Record<string, V> = {};
        for (const pair of kit.itemsOf(value) ?? []) {
          const [key, item] = kit.itemsOf(pair) ?? [];
          if (key?._tag !== "Str")
            return yield* unseen(site, "makes a record of Optic.entries of keys it cannot see");
          fields[key.value] = item ?? Value.undef;
        }
        return FOUND(Value.obj(fields));
      }),
  };

  // ---- A traversal: an optic onto an array, and one onto each of its items.

  /**
   * `optic.forEach((each) => inner)`: one Optional over the whole optic before
   * it, onto the items `inner` finds. Putting them back needs as many as it found.
   */
  const traversal = (
    outer: ReadonlyArray<OpticStep>,
    inner: ReadonlyArray<OpticStep>,
  ): OpticStep => ({
    kind: "Optional",
    get: (source, site) =>
      Effect.gen(function* () {
        const got = yield* found(outer, source, site);
        if (!got.ok) return MISSED;
        const kept: Array<V> = [];
        for (const item of yield* itemsOf(got.value, site)) {
          const each = yield* found(inner, item, site);
          if (each.ok) kept.push(each.value);
        }
        return FOUND(arr(kept));
      }),
    set: (values, source, site) =>
      Effect.gen(function* () {
        const got = yield* found(outer, source, site);
        if (!got.ok) return MISSED;
        const items = yield* itemsOf(got.value, site);
        const given = yield* itemsOf(values, site);
        const at: Array<number> = [];
        for (const [index, item] of items.entries())
          if ((yield* found(inner, item, site)).ok) at.push(index);
        if (given.length !== at.length) return MISSED;
        const out = [...items];
        for (const [k, index] of at.entries()) {
          const put = yield* replaced(inner, given[k]!, items[index]!, site);
          if (!put.ok) return MISSED;
          out[index] = put.value;
        }
        return yield* replaced(outer, arr(out), source, site);
      }),
  });
  const itemsOf = (v: V, site: Site): Eval<ReadonlyArray<V>> => {
    const items = kit.itemsOf(v);
    return items
      ? Effect.succeed(items)
      : unseen(
          site,
          "an optic goes over the items of a value that is not an array it knows the length of",
        );
  };
  /** Every item a traversal finds: none where it finds nothing. */
  const getAll = (path: ReadonlyArray<OpticStep>, source: V, site: Site): Eval<V> =>
    Effect.map(found(path, source, site), (got) => (got.ok ? got.value : arr([])));
  /** Each item a traversal finds, changed by the function. */
  const modifyAll = (path: ReadonlyArray<OpticStep>, f: V, source: V, site: Site): Eval<V> =>
    Effect.gen(function* () {
      const got = yield* found(path, source, site);
      if (!got.ok) return source;
      const changed: Array<V> = [];
      for (const item of yield* itemsOf(got.value, site))
        changed.push(yield* host.call(f, [item], site));
      const put = yield* replaced(path, arr(changed), source, site);
      return put.ok ? put.value : source;
    });

  // ---- The methods of an optic value.

  const member = (self: Optic, key: string): V | undefined => {
    const path = self.path;
    const extend = (step: (name: string) => OpticStep) =>
      native(`optic.${key}`, ([name], site) => {
        const value = str(name);
        return value === undefined
          ? wrongArguments(site, `optic.${key}`)
          : Effect.succeed<V>(optic([...path, step(value)]));
      });
    switch (key) {
      case "key":
        return extend(keyStep);
      case "optionalKey":
        return extend(optionalKeyStep);
      case "at":
        return extend(atStep);
      case "tag":
        return extend(tagStep);
      case "notUndefined":
        return native("optic.notUndefined", () =>
          Effect.succeed<V>(optic([...path, notUndefinedStep])),
        );
      case "refine":
        return native("optic.refine", ([test], site) =>
          test
            ? Effect.succeed<V>(
                optic([
                  ...path,
                  refineStep((source, at) => decided(host.call(test, [source], at), at)),
                ]),
              )
            : wrongArguments(site, "optic.refine"),
        );
      case "compose":
        return native("optic.compose", ([that], site) =>
          isOptic(that)
            ? Effect.succeed<V>(optic([...path, ...that.path]))
            : wrongArguments(site, "optic.compose"),
        );
      case "get":
        return native("optic.get", ([source], site) =>
          source ? get(path, source, site) : wrongArguments(site, "optic.get"),
        );
      case "getResult":
        return native("optic.getResult", ([source], site) =>
          source ? getResult(path, source, site) : wrongArguments(site, "optic.getResult"),
        );
      case "replace":
        return native("optic.replace", ([value, source], site) =>
          value && source
            ? replace(path, value, source, site)
            : wrongArguments(site, "optic.replace"),
        );
      case "replaceResult":
        return native("optic.replaceResult", ([value, source], site) =>
          value && source
            ? replaceResult(path, value, source, site)
            : wrongArguments(site, "optic.replaceResult"),
        );
      case "modify":
        return native("optic.modify", ([f], site) =>
          f
            ? Effect.succeed(
                native("optic.modify", ([source], at) =>
                  source ? modify(path, f, source, at) : wrongArguments(at, "optic.modify"),
                ),
              )
            : wrongArguments(site, "optic.modify"),
        );
      case "forEach":
        return native("optic.forEach", ([f], site) =>
          f
            ? Effect.flatMap(host.call(f, [optic([])], site), (inner) =>
                isOptic(inner)
                  ? Effect.succeed<V>(optic([traversal(path, inner.path)]))
                  : wrongArguments(site, "optic.forEach"),
              )
            : wrongArguments(site, "optic.forEach"),
        );
      case "modifyAll":
        return native("optic.modifyAll", ([f], site) =>
          f
            ? Effect.succeed(
                native("optic.modifyAll", ([source], at) =>
                  source ? modifyAll(path, f, source, at) : wrongArguments(at, "optic.modifyAll"),
                ),
              )
            : wrongArguments(site, "optic.modifyAll"),
        );
      case "set":
        return native("optic.set", ([value], site) =>
          value ? set(path, value, site) : wrongArguments(site, "optic.set"),
        );
      default:
        return undefined;
    }
  };

  // ---- The module's functions: the value first, or the optic first and the value later.

  /** `Optic.get(source, optic)`, or `Optic.get(optic)` then the source. */
  const reading =
    (
      name: string,
      read: (path: ReadonlyArray<OpticStep>, source: V, site: Site) => Eval<V>,
    ): Model =>
    ([a, b], site) => {
      if (a && isOptic(b)) return read(b.path, a, site);
      if (isOptic(a) && b === undefined)
        return Effect.succeed(
          native(name, ([source], at) =>
            source ? read(a.path, source, at) : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };
  /** `Optic.replace(source, optic, value)`, or `Optic.replace(optic, value)` then the source. */
  const changing =
    (
      name: string,
      change: (path: ReadonlyArray<OpticStep>, x: V, source: V, site: Site) => Eval<V>,
    ): Model =>
    (args, site) => {
      const [a, b, c] = args;
      if (args.length === 3 && a && isOptic(b) && c) return change(b.path, c, a, site);
      if (args.length === 2 && isOptic(a) && b)
        return Effect.succeed(
          native(name, ([source], at) =>
            source ? change(a.path, b, source, at) : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };
  const prism =
    (step: OpticStep): Model =>
    () =>
      Effect.succeed<V>(optic([step]));

  const models: Models = {
    "effect/Optic:id": () => Effect.succeed<V>(optic([])),
    "effect/Optic:get": reading("Optic.get", get),
    "effect/Optic:getResult": reading("Optic.getResult", getResult),
    // `Optic.set(value, optic)`: the whole value a Prism or an Iso makes of a focus.
    "effect/Optic:set": reading("Optic.set", (path, value, site) => set(path, value, site)),
    "effect/Optic:replace": changing("Optic.replace", replace),
    "effect/Optic:getAll": reading("Optic.getAll", getAll),
    "effect/Optic:modifyAll": changing("Optic.modifyAll", modifyAll),
    "effect/Optic:replaceResult": changing("Optic.replaceResult", replaceResult),
    "effect/Optic:modify": changing("Optic.modify", modify),
    "effect/Optic:makeIso": ([getter, setter], site) =>
      getter && setter
        ? Effect.succeed<V>(
            optic([madeStep("Iso", "Optic.makeIso", getter, setter, "value", "value")]),
          )
        : wrongArguments(site, "Optic.makeIso"),
    "effect/Optic:makeLens": ([getter, setter], site) =>
      getter && setter
        ? Effect.succeed<V>(
            optic([madeStep("Lens", "Optic.makeLens", getter, setter, "value", "value")]),
          )
        : wrongArguments(site, "Optic.makeLens"),
    "effect/Optic:makePrism": ([getter, setter], site) =>
      getter && setter
        ? Effect.succeed<V>(
            optic([madeStep("Prism", "Optic.makePrism", getter, setter, "result", "value")]),
          )
        : wrongArguments(site, "Optic.makePrism"),
    "effect/Optic:makeOptional": ([getter, setter], site) =>
      getter && setter
        ? Effect.succeed<V>(
            optic([madeStep("Optional", "Optic.makeOptional", getter, setter, "result", "result")]),
          )
        : wrongArguments(site, "Optic.makeOptional"),
    "effect/Optic:some": prism(
      branchStep((source) => {
        const option = Value.optionOf(source);
        return option?._tag === "Some" ? FOUND(option.value) : MISSED;
      }, Value.some),
    ),
    "effect/Optic:none": prism(
      branchStep(
        (source) => (Value.optionOf(source)?._tag === "None" ? FOUND(Value.undef) : MISSED),
        () => Value.none,
      ),
    ),
    "effect/Optic:success": prism(
      branchStep((source) => {
        const read = Brands.resultOf(source);
        return read?._tag === "Success" ? FOUND(read.success) : MISSED;
      }, Brands.success),
    ),
    "effect/Optic:failure": prism(
      branchStep((source) => {
        const read = Brands.resultOf(source);
        return read?._tag === "Failure" ? FOUND(read.failure) : MISSED;
      }, Brands.failure),
    ),
    "effect/Optic:entries": prism(entriesStep),
  };

  return { models, member };
};
