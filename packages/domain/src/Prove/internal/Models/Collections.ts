import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import * as Compare from "../Compare.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, counted, dual, keyed, native, onRecord, str, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

/**
 * `Array`, `Record`, `Struct` and `Tuple`. An array's items, and an object's
 * keys, are ones the prover sees; what a function gives for an item may be a
 * formula, and then deciding on it splits the path.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  /** A function of anything the library goes over: an array, a hash set, a hash map. */
  const onItems = (
    name: string,
    arity: number,
    body: (items: ReadonlyArray<V>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) =>
      self
        ? Effect.flatMap(kit.iterate(self, site), (items) =>
            items ? body(items, rest, site) : wrongArguments(site, name),
          )
        : wrongArguments(site, name),
    );

  const pair = (a: V, b: V): V => arr([a, b]);

  /** Whether a function holds of each item, in order: each one splits the path where an input decides. */
  const holding = (items: ReadonlyArray<V>, fn: V, site: Site): Eval<ReadonlyArray<boolean>> =>
    Effect.forEach(items, (item, index) => kit.holds(fn, [item, Value.num(index)], site));

  /** Whether a value is one of the items, by the library's equality: known, or a formula. */
  const among = (items: ReadonlyArray<V>, wanted: V, site: Site): Eval<Compare.Known> =>
    Effect.map(
      Effect.forEach(items, (item) => kit.equality(item, wanted, site)),
      Compare.any,
    );

  /** Whether a value is one of the items, on this path. */
  const has = (items: ReadonlyArray<V>, wanted: V, site: Site): Eval<boolean> =>
    Effect.flatMap(among(items, wanted, site), (found) =>
      host.decide(Compare.fromTruth(found as boolean | string), site),
    );

  /** The items without the ones equal to an earlier one. */
  const dedupe = (
    items: ReadonlyArray<V>,
    site: Site,
    same: (a: V, b: V) => Eval<boolean> = (a, b) =>
      Effect.flatMap(kit.equals(a, b, site), (equal) => host.decide(equal, site)),
  ): Eval<ReadonlyArray<V>> =>
    Effect.gen(function* () {
      const out: Array<V> = [];
      next: for (const item of items) {
        for (const kept of out) if (yield* same(item, kept)) continue next;
        out.push(item);
      }
      return out;
    });

  const fnOf = (name: string, fn: V | undefined, site: Site): Eval<V> =>
    fn ? Effect.succeed(fn) : wrongArguments(site, name);

  const listOf = (name: string, v: V | undefined, site: Site): Eval<ReadonlyArray<V>> =>
    v
      ? Effect.flatMap(kit.iterate(v, site), (items) =>
          items ? Effect.succeed(items) : wrongArguments(site, name),
        )
      : wrongArguments(site, name);

  const nonEmpty = (name: string, items: ReadonlyArray<V>, site: Site): Eval<void> =>
    items.length > 0
      ? Effect.void
      : Effect.fail(Value.notTranslated(site, `${name} is given an empty array`));

  /** The smallest of the items by an order, or the largest: the first of those the order says nothing between. */
  const extreme = (name: string, largest: boolean): Model =>
    onItems(name, 2, (items, [by], site) =>
      Effect.gen(function* () {
        yield* nonEmpty(name, items, site);
        let best = items[0]!;
        for (const item of items.slice(1))
          if (yield* largest ? kit.before(by, best, item, site) : kit.before(by, item, best, site))
            best = item;
        return best;
      }),
    );

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  /** A string a function gives as a key: one the prover cannot see is not translated. */
  const keyFrom = (name: string, fn: V, args: ReadonlyArray<V>, site: Site): Eval<string> =>
    Effect.flatMap(host.call(fn, args, site), (key) => keyed(name, key, site));

  const arrays: Models = {
    "effect/Array:make": (args) => Effect.succeed(arr(args)),
    "effect/Array:of": ([item]) => Effect.succeed(arr([item ?? Value.undef])),
    "effect/Array:empty": () => Effect.succeed(arr([])),
    "effect/Array:range": ([start, end], site) =>
      Effect.gen(function* () {
        const from = yield* counted("Array.range", start, site);
        const to = yield* counted("Array.range", end, site);
        const out: Array<V> = [Value.num(from)];
        for (let n = from + 1; n <= to; n++) out.push(Value.num(n));
        return arr(out);
      }),
    "effect/Array:makeBy": dual("Array.makeBy", 2, ([n, f], site) =>
      Effect.gen(function* () {
        const count = Math.max(1, yield* counted("Array.makeBy", n, site));
        const fn = yield* fnOf("Array.makeBy", f, site);
        const out: Array<V> = [];
        for (let i = 0; i < count; i++) out.push(yield* host.call(fn, [Value.num(i)], site));
        return arr(out);
      }),
    ),
    "effect/Array:replicate": dual("Array.replicate", 2, ([item, n], site) =>
      Effect.map(counted("Array.replicate", n, site), (count) =>
        arr(Array.from({ length: Math.max(1, count) }, () => item ?? Value.undef)),
      ),
    ),
    "effect/Array:fromIterable": onItems("Array.fromIterable", 1, (items) =>
      Effect.succeed(arr(items)),
    ),
    "effect/Array:copy": onItems("Array.copy", 1, (items) => Effect.succeed(arr([...items]))),
    "effect/Array:fromOption": ([option], site) => {
      const read = Value.optionOf(option);
      return read
        ? Effect.succeed(arr(read._tag === "Some" ? [read.value] : []))
        : wrongArguments(site, "Array.fromOption");
    },
    "effect/Array:fromNullishOr": ([value]) =>
      Effect.succeed(arr(!value || value._tag === "Null" || value._tag === "Undef" ? [] : [value])),
    "effect/Array:fromRecord": onRecord("Array.fromRecord", 1, (fields) =>
      Effect.succeed(
        arr(Object.entries(fields).map(([key, value]) => pair(Value.str(key), value))),
      ),
    ),
    "effect/Array:ensure": ([value]) => {
      const items = kit.itemsOf(value);
      return Effect.succeed(items ? arr(items) : arr([value ?? Value.undef]));
    },
    "effect/Array:isArray": ([value], site) =>
      value && value._tag !== "Opaque" && value._tag !== "Applied"
        ? Effect.succeed(Value.bool(kit.itemsOf(value) !== undefined))
        : wrongArguments(site, "Array.isArray"),
    "effect/Array:contains": onItems("Array.contains", 2, (items, [wanted], site) =>
      Effect.map(among(items, wanted ?? Value.undef, site), (found) =>
        Compare.fromTruth(found as boolean | string),
      ),
    ),
    // An option-returning function gives what it found; a predicate gives the item.
    "effect/Array:findFirst": onItems("Array.findFirst", 2, (items, [fn], site) =>
      fn
        ? Effect.gen(function* () {
            for (const [index, item] of items.entries()) {
              const found = yield* host.call(fn, [item, Value.num(index)], site);
              const option = Value.optionOf(found);
              if (option ? option._tag === "Some" : yield* host.decide(found, site))
                return option ? found : Value.some(item);
            }
            return Value.none;
          })
        : wrongArguments(site, "Array.findFirst"),
    ),
    "effect/Array:findLast": onItems("Array.findLast", 2, (items, [fn], site) =>
      fn
        ? Effect.gen(function* () {
            for (let index = items.length - 1; index >= 0; index--) {
              const found = yield* host.call(fn, [items[index]!, Value.num(index)], site);
              const option = Value.optionOf(found);
              if (option ? option._tag === "Some" : yield* host.decide(found, site))
                return option ? found : Value.some(items[index]!);
            }
            return Value.none;
          })
        : wrongArguments(site, "Array.findLast"),
    ),
    "effect/Array:findFirstIndex": onItems("Array.findFirstIndex", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.findFirstIndex", fn, site);
        for (const [index, item] of items.entries())
          if (yield* kit.holds(f, [item, Value.num(index)], site))
            return Value.some(Value.num(index));
        return Value.none;
      }),
    ),
    "effect/Array:findLastIndex": onItems("Array.findLastIndex", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.findLastIndex", fn, site);
        for (let index = items.length - 1; index >= 0; index--)
          if (yield* kit.holds(f, [items[index]!, Value.num(index)], site))
            return Value.some(Value.num(index));
        return Value.none;
      }),
    ),
    "effect/Array:take": onItems("Array.take", 2, (items, [n], site) =>
      Effect.map(counted("Array.take", n, site), (count) =>
        arr(items.slice(0, Math.max(0, count))),
      ),
    ),
    "effect/Array:takeRight": onItems("Array.takeRight", 2, (items, [n], site) =>
      Effect.map(counted("Array.takeRight", n, site), (count) =>
        arr(count <= 0 ? [] : items.slice(-count)),
      ),
    ),
    "effect/Array:drop": onItems("Array.drop", 2, (items, [n], site) =>
      Effect.map(counted("Array.drop", n, site), (count) => arr(items.slice(Math.max(0, count)))),
    ),
    "effect/Array:dropRight": onItems("Array.dropRight", 2, (items, [n], site) =>
      Effect.map(counted("Array.dropRight", n, site), (count) =>
        arr(items.slice(0, Math.max(0, items.length - Math.max(0, count)))),
      ),
    ),
    "effect/Array:takeWhile": onItems("Array.takeWhile", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.takeWhile", fn, site);
        let index = 0;
        while (
          index < items.length &&
          (yield* kit.holds(f, [items[index]!, Value.num(index)], site))
        )
          index++;
        return arr(items.slice(0, index));
      }),
    ),
    "effect/Array:dropWhile": onItems("Array.dropWhile", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.dropWhile", fn, site);
        let index = 0;
        while (
          index < items.length &&
          (yield* kit.holds(f, [items[index]!, Value.num(index)], site))
        )
          index++;
        return arr(items.slice(index));
      }),
    ),
    "effect/Array:span": onItems("Array.span", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.span", fn, site);
        let index = 0;
        while (
          index < items.length &&
          (yield* kit.holds(f, [items[index]!, Value.num(index)], site))
        )
          index++;
        return pair(arr(items.slice(0, index)), arr(items.slice(index)));
      }),
    ),
    "effect/Array:splitAt": onItems("Array.splitAt", 2, (items, [n], site) =>
      Effect.map(counted("Array.splitAt", n, site), (count) => {
        const at = Math.max(0, count);
        return pair(arr(items.slice(0, at)), arr(items.slice(at)));
      }),
    ),
    "effect/Array:chunksOf": onItems("Array.chunksOf", 2, (items, [n], site) =>
      Effect.map(counted("Array.chunksOf", n, site), (count) => {
        const size = Math.max(1, count);
        const out: Array<V> = [];
        for (let at = 0; at < items.length; at += size) out.push(arr(items.slice(at, at + size)));
        return arr(out);
      }),
    ),
    "effect/Array:reverse": onItems("Array.reverse", 1, (items) =>
      Effect.succeed(arr([...items].reverse())),
    ),
    "effect/Array:zip": onItems("Array.zip", 2, (items, [that], site) =>
      Effect.map(listOf("Array.zip", that, site), (others) =>
        arr(
          items
            .slice(0, Math.min(items.length, others.length))
            .map((item, index) => pair(item, others[index]!)),
        ),
      ),
    ),
    "effect/Array:zipWith": onItems("Array.zipWith", 3, (items, [that, fn], site) =>
      Effect.gen(function* () {
        const others = yield* listOf("Array.zipWith", that, site);
        const f = yield* fnOf("Array.zipWith", fn, site);
        const out: Array<V> = [];
        for (let index = 0; index < Math.min(items.length, others.length); index++)
          out.push(yield* host.call(f, [items[index]!, others[index]!], site));
        return arr(out);
      }),
    ),
    "effect/Array:unzip": onItems("Array.unzip", 1, (items, _, site) => {
      const pairs = items.map((item) => kit.itemsOf(item));
      return pairs.every((p) => p && p.length === 2)
        ? Effect.succeed(pair(arr(pairs.map((p) => p![0]!)), arr(pairs.map((p) => p![1]!))))
        : wrongArguments(site, "Array.unzip");
    }),
    "effect/Array:cartesian": onItems("Array.cartesian", 2, (items, [that], site) =>
      Effect.map(listOf("Array.cartesian", that, site), (others) =>
        arr(items.flatMap((item) => others.map((other) => pair(item, other)))),
      ),
    ),
    "effect/Array:cartesianWith": onItems("Array.cartesianWith", 3, (items, [that, fn], site) =>
      Effect.gen(function* () {
        const others = yield* listOf("Array.cartesianWith", that, site);
        const f = yield* fnOf("Array.cartesianWith", fn, site);
        const out: Array<V> = [];
        for (const item of items)
          for (const other of others) out.push(yield* host.call(f, [item, other], site));
        return arr(out);
      }),
    ),
    // The function gives a `Result`: what succeeded on one side, what failed on the other.
    "effect/Array:partition": onItems("Array.partition", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.partition", fn, site);
        const passes: Array<V> = [];
        const fails: Array<V> = [];
        for (const [index, item] of items.entries()) {
          const made = Brands.resultOf(yield* host.call(f, [item, Value.num(index)], site));
          if (!made) return yield* wrongArguments(site, "Array.partition");
          if (made._tag === "Success") passes.push(made.success);
          else fails.push(made.failure);
        }
        return pair(arr(passes), arr(fails));
      }),
    ),
    "effect/Array:filterMap": onItems("Array.filterMap", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.filterMap", fn, site);
        const out: Array<V> = [];
        for (const [index, item] of items.entries()) {
          const made = Brands.resultOf(yield* host.call(f, [item, Value.num(index)], site));
          if (!made) return yield* wrongArguments(site, "Array.filterMap");
          if (made._tag === "Success") out.push(made.success);
        }
        return arr(out);
      }),
    ),
    "effect/Array:separate": onItems("Array.separate", 1, (items, _, site) => {
      const results = items.map((item) => Brands.resultOf(item));
      return results.every((result) => result)
        ? Effect.succeed(
            pair(
              arr(results.flatMap((r) => (r!._tag === "Success" ? [r!.success] : []))),
              arr(results.flatMap((r) => (r!._tag === "Failure" ? [r!.failure] : []))),
            ),
          )
        : wrongArguments(site, "Array.separate");
    }),
    "effect/Array:getSomes": onItems("Array.getSomes", 1, (items, _, site) => {
      const options = items.map((item) => Value.optionOf(item));
      return options.every((option) => option)
        ? Effect.succeed(arr(options.flatMap((o) => (o!._tag === "Some" ? [o!.value] : []))))
        : wrongArguments(site, "Array.getSomes");
    }),
    "effect/Array:getSuccesses": onItems("Array.getSuccesses", 1, (items, _, site) => {
      const results = items.map((item) => Brands.resultOf(item));
      return results.every((result) => result)
        ? Effect.succeed(arr(results.flatMap((r) => (r!._tag === "Success" ? [r!.success] : []))))
        : wrongArguments(site, "Array.getSuccesses");
    }),
    "effect/Array:getFailures": onItems("Array.getFailures", 1, (items, _, site) => {
      const results = items.map((item) => Brands.resultOf(item));
      return results.every((result) => result)
        ? Effect.succeed(arr(results.flatMap((r) => (r!._tag === "Failure" ? [r!.failure] : []))))
        : wrongArguments(site, "Array.getFailures");
    }),
    "effect/Array:dedupe": onItems("Array.dedupe", 1, (items, _, site) =>
      Effect.map(dedupe(items, site), arr),
    ),
    "effect/Array:dedupeWith": onItems("Array.dedupeWith", 2, (items, [same], site) =>
      same
        ? Effect.map(
            dedupe(items, site, (a, b) => kit.holds(same, [a, b], site)),
            arr,
          )
        : wrongArguments(site, "Array.dedupeWith"),
    ),
    // As the library does it: two arrays with items are joined and deduped, and one alone is given as it is.
    "effect/Array:union": onItems("Array.union", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* listOf("Array.union", that, site);
        if (items.length === 0) return arr(others);
        return arr(others.length === 0 ? items : yield* dedupe([...items, ...others], site));
      }),
    ),
    "effect/Array:intersection": onItems("Array.intersection", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* listOf("Array.intersection", that, site);
        const out: Array<V> = [];
        for (const item of items) if (yield* has(others, item, site)) out.push(item);
        return arr(out);
      }),
    ),
    "effect/Array:difference": onItems("Array.difference", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* listOf("Array.difference", that, site);
        const out: Array<V> = [];
        for (const item of items) if (!(yield* has(others, item, site))) out.push(item);
        return arr(out);
      }),
    ),
    "effect/Array:join": onItems("Array.join", 2, (items, [separator], site) =>
      Effect.gen(function* () {
        let out: V = Value.str("");
        for (const [index, item] of items.entries()) {
          if (index > 0) out = yield* host.arithmetic("+", out, separator ?? Value.str(","), site);
          out = yield* host.arithmetic("+", out, item, site);
        }
        return out;
      }),
    ),
    "effect/Array:flatten": onItems("Array.flatten", 1, (items, _, site) => {
      const inner = items.map((item) => kit.itemsOf(item));
      return inner.every((list) => list)
        ? Effect.succeed(arr(inner.flatMap((list) => list!)))
        : wrongArguments(site, "Array.flatten");
    }),
    "effect/Array:tail": onItems("Array.tail", 1, (items) =>
      Effect.succeed(items.length > 0 ? Value.some(arr(items.slice(1))) : Value.none),
    ),
    "effect/Array:init": onItems("Array.init", 1, (items) =>
      Effect.succeed(items.length > 0 ? Value.some(arr(items.slice(0, -1))) : Value.none),
    ),
    "effect/Array:headNonEmpty": onItems("Array.headNonEmpty", 1, (items, _, site) =>
      Effect.as(nonEmpty("Array.headNonEmpty", items, site), items[0]!),
    ),
    "effect/Array:lastNonEmpty": onItems("Array.lastNonEmpty", 1, (items, _, site) =>
      Effect.as(nonEmpty("Array.lastNonEmpty", items, site), items[items.length - 1]!),
    ),
    "effect/Array:tailNonEmpty": onItems("Array.tailNonEmpty", 1, (items, _, site) =>
      Effect.as(nonEmpty("Array.tailNonEmpty", items, site), arr(items.slice(1))),
    ),
    "effect/Array:initNonEmpty": onItems("Array.initNonEmpty", 1, (items, _, site) =>
      Effect.as(nonEmpty("Array.initNonEmpty", items, site), arr(items.slice(0, -1))),
    ),
    "effect/Array:unprepend": onItems("Array.unprepend", 1, (items, _, site) =>
      Effect.as(nonEmpty("Array.unprepend", items, site), pair(items[0]!, arr(items.slice(1)))),
    ),
    "effect/Array:unappend": onItems("Array.unappend", 1, (items, _, site) =>
      Effect.as(
        nonEmpty("Array.unappend", items, site),
        pair(arr(items.slice(0, -1)), items[items.length - 1]!),
      ),
    ),
    "effect/Array:getUnsafe": onItems("Array.getUnsafe", 2, (items, [index], site) =>
      Effect.flatMap(counted("Array.getUnsafe", index, site), (at) =>
        items[at]
          ? Effect.succeed(items[at])
          : Effect.fail(
              Value.notTranslated(site, "Array.getUnsafe reads past the end of an array"),
            ),
      ),
    ),
    "effect/Array:countBy": onItems("Array.countBy", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.countBy", fn, site);
        return Value.num((yield* holding(items, f, site)).filter((held) => held).length);
      }),
    ),
    "effect/Array:sort": onItems("Array.sort", 2, (items, [by], site) =>
      Effect.map(kit.sorted(items, by, site), arr),
    ),
    "effect/Array:sortWith": onItems("Array.sortWith", 3, (items, [fn, by], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.sortWith", fn, site);
        const keys = new Map<V, V>();
        for (const item of items) keys.set(item, yield* host.call(f, [item], site));
        const order = kit.order("Array.sortWith", (a, b, at) =>
          kit.lessThan(by, keys.get(a) ?? a, keys.get(b) ?? b, at),
        );
        return arr(yield* kit.sorted(items, order, site));
      }),
    ),
    // `Array.sortBy(first, second)`: by the first order, and by the next where it says nothing.
    "effect/Array:sortBy": (orders, site) =>
      Effect.succeed(
        native("Array.sortBy", ([self], at) =>
          Effect.gen(function* () {
            const items = yield* listOf("Array.sortBy", self, at);
            const order = kit.order("Array.sortBy", (a, b, where) =>
              Effect.gen(function* () {
                for (const by of orders) {
                  if (yield* kit.before(by, a, b, where)) return Value.bool(true);
                  if (yield* kit.before(by, b, a, where)) return Value.bool(false);
                }
                return Value.bool(false);
              }),
            );
            return arr(yield* kit.sorted(items, order, site));
          }),
        ),
      ),
    "effect/Array:min": extreme("Array.min", false),
    "effect/Array:max": extreme("Array.max", true),
    "effect/Array:forEach": onItems("Array.forEach", 2, (items, [fn], site) =>
      fn
        ? host.array("forEach", items, fn, undefined, site)
        : wrongArguments(site, "Array.forEach"),
    ),
    "effect/Array:reduceRight": onItems("Array.reduceRight", 3, (items, [initial, fn], site) =>
      initial && fn
        ? Effect.gen(function* () {
            let total = initial;
            for (let index = items.length - 1; index >= 0; index--)
              total = yield* host.call(fn, [total, items[index]!, Value.num(index)], site);
            return total;
          })
        : wrongArguments(site, "Array.reduceRight"),
    ),
    "effect/Array:scan": onItems("Array.scan", 3, (items, [initial, fn], site) =>
      initial && fn
        ? Effect.gen(function* () {
            const out: Array<V> = [initial];
            for (const item of items) out.push(yield* host.call(fn, [out.at(-1)!, item], site));
            return arr(out);
          })
        : wrongArguments(site, "Array.scan"),
    ),
    "effect/Array:mapAccum": onItems("Array.mapAccum", 3, (items, [initial, fn], site) =>
      initial && fn
        ? Effect.gen(function* () {
            let state = initial;
            const out: Array<V> = [];
            for (const [index, item] of items.entries()) {
              const made = kit.itemsOf(yield* host.call(fn, [state, item, Value.num(index)], site));
              if (!made || made.length !== 2) return yield* wrongArguments(site, "Array.mapAccum");
              state = made[0]!;
              out.push(made[1]!);
            }
            return pair(state, arr(out));
          })
        : wrongArguments(site, "Array.mapAccum"),
    ),
    "effect/Array:insertAt": onItems("Array.insertAt", 3, (items, [index, item], site) =>
      Effect.map(counted("Array.insertAt", index, site), (at) =>
        at < 0 || at > items.length
          ? Value.none
          : Value.some(arr([...items.slice(0, at), item ?? Value.undef, ...items.slice(at)])),
      ),
    ),
    "effect/Array:modify": onItems("Array.modify", 3, (items, [index, fn], site) =>
      Effect.gen(function* () {
        const at = yield* counted("Array.modify", index, site);
        const f = yield* fnOf("Array.modify", fn, site);
        if (at < 0 || at >= items.length) return Value.none;
        const made = yield* host.call(f, [items[at]!], site);
        return Value.some(arr([...items.slice(0, at), made, ...items.slice(at + 1)]));
      }),
    ),
    "effect/Array:replace": onItems("Array.replace", 3, (items, [index, item], site) =>
      Effect.map(counted("Array.replace", index, site), (at) =>
        at < 0 || at >= items.length
          ? Value.none
          : Value.some(arr([...items.slice(0, at), item ?? Value.undef, ...items.slice(at + 1)])),
      ),
    ),
    "effect/Array:remove": onItems("Array.remove", 2, (items, [index], site) =>
      Effect.map(counted("Array.remove", index, site), (at) =>
        arr(at < 0 || at >= items.length ? items : [...items.slice(0, at), ...items.slice(at + 1)]),
      ),
    ),
    "effect/Array:prependAll": onItems("Array.prependAll", 2, (items, [that], site) =>
      Effect.map(listOf("Array.prependAll", that, site), (others) => arr([...others, ...items])),
    ),
    "effect/Array:intersperse": onItems("Array.intersperse", 2, (items, [middle]) =>
      Effect.succeed(
        arr(items.flatMap((item, index) => (index === 0 ? [item] : [middle ?? Value.undef, item]))),
      ),
    ),
    // The key a function gives each item has to be one the prover sees.
    "effect/Array:groupBy": onItems("Array.groupBy", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.groupBy", fn, site);
        const groups: Record<string, Array<V>> = {};
        for (const item of items)
          (groups[yield* keyFrom("Array.groupBy", f, [item], site)] ??= []).push(item);
        return Value.obj(
          Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, arr(group)])),
        );
      }),
    ),
    "effect/Array:match": onItems("Array.match", 2, (items, [cases], site) => {
      const handler = handlerOf(cases, items.length === 0 ? "onEmpty" : "onNonEmpty");
      return handler
        ? host.call(handler, items.length === 0 ? [] : [arr(items)], site)
        : wrongArguments(site, "Array.match");
    }),
    "effect/Array:matchLeft": onItems("Array.matchLeft", 2, (items, [cases], site) => {
      const handler = handlerOf(cases, items.length === 0 ? "onEmpty" : "onNonEmpty");
      return handler
        ? host.call(handler, items.length === 0 ? [] : [items[0]!, arr(items.slice(1))], site)
        : wrongArguments(site, "Array.matchLeft");
    }),
    "effect/Array:matchRight": onItems("Array.matchRight", 2, (items, [cases], site) => {
      const handler = handlerOf(cases, items.length === 0 ? "onEmpty" : "onNonEmpty");
      return handler
        ? host.call(
            handler,
            items.length === 0 ? [] : [arr(items.slice(0, -1)), items[items.length - 1]!],
            site,
          )
        : wrongArguments(site, "Array.matchRight");
    }),
    "effect/Array:flatMapNullishOr": onItems("Array.flatMapNullishOr", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Array.flatMapNullishOr", fn, site);
        const out: Array<V> = [];
        for (const item of items) {
          const made = yield* host.call(f, [item], site);
          if (made._tag !== "Null" && made._tag !== "Undef") out.push(made);
        }
        return arr(out);
      }),
    ),
  };

  const record = (entries: ReadonlyArray<readonly [string, V]>): V =>
    Value.obj(Object.fromEntries(entries));

  /** An array's item as a key and a value, where the code writes it as a pair. */
  const entryOf = (name: string, v: V, site: Site): Eval<readonly [string, V]> => {
    const items = kit.itemsOf(v);
    return items && items.length === 2
      ? Effect.map(keyed(name, items[0], site), (key) => [key, items[1]!] as const)
      : wrongArguments(site, name);
  };

  const records: Models = {
    "effect/Record:empty": () => Effect.succeed(Value.obj({})),
    "effect/Record:singleton": ([key, value], site) =>
      Effect.map(keyed("Record.singleton", key, site), (name) =>
        record([[name, value ?? Value.undef]]),
      ),
    "effect/Record:toEntries": onRecord("Record.toEntries", 1, (fields) =>
      Effect.succeed(
        arr(Object.entries(fields).map(([key, value]) => pair(Value.str(key), value))),
      ),
    ),
    "effect/Record:fromEntries": ([entries], site) =>
      Effect.gen(function* () {
        const items = yield* listOf("Record.fromEntries", entries, site);
        const out: Array<readonly [string, V]> = [];
        for (const item of items) out.push(yield* entryOf("Record.fromEntries", item, site));
        return record(out);
      }),
    "effect/Record:fromIterableWith": dual("Record.fromIterableWith", 2, ([self, fn], site) =>
      Effect.gen(function* () {
        const items = yield* listOf("Record.fromIterableWith", self, site);
        const f = yield* fnOf("Record.fromIterableWith", fn, site);
        const out: Array<readonly [string, V]> = [];
        for (const item of items)
          out.push(
            yield* entryOf("Record.fromIterableWith", yield* host.call(f, [item], site), site),
          );
        return record(out);
      }),
    ),
    "effect/Record:fromIterableBy": dual("Record.fromIterableBy", 2, ([self, fn], site) =>
      Effect.gen(function* () {
        const items = yield* listOf("Record.fromIterableBy", self, site);
        const f = yield* fnOf("Record.fromIterableBy", fn, site);
        const out: Array<readonly [string, V]> = [];
        for (const item of items)
          out.push([yield* keyFrom("Record.fromIterableBy", f, [item], site), item]);
        return record(out);
      }),
    ),
    "effect/Record:filter": onRecord("Record.filter", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.filter", fn, site);
        const out: Array<readonly [string, V]> = [];
        for (const [key, value] of Object.entries(fields))
          if (yield* kit.holds(f, [value, Value.str(key)], site)) out.push([key, value]);
        return record(out);
      }),
    ),
    "effect/Record:filterMap": onRecord("Record.filterMap", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.filterMap", fn, site);
        const out: Array<readonly [string, V]> = [];
        for (const [key, value] of Object.entries(fields)) {
          const made = Brands.resultOf(yield* host.call(f, [value, Value.str(key)], site));
          if (!made) return yield* wrongArguments(site, "Record.filterMap");
          if (made._tag === "Success") out.push([key, made.success]);
        }
        return record(out);
      }),
    ),
    "effect/Record:partition": onRecord("Record.partition", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.partition", fn, site);
        const passes: Array<readonly [string, V]> = [];
        const fails: Array<readonly [string, V]> = [];
        for (const [key, value] of Object.entries(fields)) {
          const made = Brands.resultOf(yield* host.call(f, [value, Value.str(key)], site));
          if (!made) return yield* wrongArguments(site, "Record.partition");
          if (made._tag === "Success") passes.push([key, made.success]);
          else fails.push([key, made.failure]);
        }
        return pair(record(passes), record(fails));
      }),
    ),
    "effect/Record:getSomes": onRecord("Record.getSomes", 1, (fields, _, site) => {
      const out: Array<readonly [string, V]> = [];
      for (const [key, value] of Object.entries(fields)) {
        const option = Value.optionOf(value);
        if (!option) return wrongArguments(site, "Record.getSomes");
        if (option._tag === "Some") out.push([key, option.value]);
      }
      return Effect.succeed(record(out));
    }),
    "effect/Record:mapKeys": onRecord("Record.mapKeys", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.mapKeys", fn, site);
        const out: Array<readonly [string, V]> = [];
        for (const [key, value] of Object.entries(fields))
          out.push([yield* keyFrom("Record.mapKeys", f, [Value.str(key), value], site), value]);
        return record(out);
      }),
    ),
    "effect/Record:mapEntries": onRecord("Record.mapEntries", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.mapEntries", fn, site);
        const out: Array<readonly [string, V]> = [];
        for (const [key, value] of Object.entries(fields))
          out.push(
            yield* entryOf(
              "Record.mapEntries",
              yield* host.call(f, [value, Value.str(key)], site),
              site,
            ),
          );
        return record(out);
      }),
    ),
    "effect/Record:collect": onRecord("Record.collect", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.collect", fn, site);
        const out: Array<V> = [];
        for (const [key, value] of Object.entries(fields))
          out.push(yield* host.call(f, [Value.str(key), value], site));
        return arr(out);
      }),
    ),
    "effect/Record:reduce": onRecord("Record.reduce", 3, (fields, [zero, fn], site) =>
      zero && fn
        ? Effect.gen(function* () {
            let total = zero;
            for (const [key, value] of Object.entries(fields))
              total = yield* host.call(fn, [total, value, Value.str(key)], site);
            return total;
          })
        : wrongArguments(site, "Record.reduce"),
    ),
    // One formula over every value, so a rule over an object does not split the path.
    "effect/Record:every": onRecord("Record.every", 2, (fields, [fn], site) =>
      fn
        ? Effect.map(
            Effect.forEach(Object.entries(fields), ([key, value]) =>
              kit.truthOf(fn, [value, Value.str(key)], site),
            ),
            (parts) => Compare.fromTruth(Compare.all(parts) as boolean | string),
          )
        : wrongArguments(site, "Record.every"),
    ),
    "effect/Record:some": onRecord("Record.some", 2, (fields, [fn], site) =>
      fn
        ? Effect.map(
            Effect.forEach(Object.entries(fields), ([key, value]) =>
              kit.truthOf(fn, [value, Value.str(key)], site),
            ),
            (parts) => Compare.fromTruth(Compare.any(parts) as boolean | string),
          )
        : wrongArguments(site, "Record.some"),
    ),
    "effect/Record:findFirst": onRecord("Record.findFirst", 2, (fields, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("Record.findFirst", fn, site);
        for (const [key, value] of Object.entries(fields))
          if (yield* kit.holds(f, [value, Value.str(key)], site))
            return Value.some(pair(Value.str(key), value));
        return Value.none;
      }),
    ),
    "effect/Record:union": onRecord("Record.union", 3, (fields, [that, combine], site) =>
      that?._tag === "Obj" && !that.brand && combine
        ? Effect.gen(function* () {
            const out: Record<string, V> = { ...fields };
            for (const [key, value] of Object.entries(that.fields))
              out[key] = Object.hasOwn(fields, key)
                ? yield* host.call(combine, [fields[key]!, value], site)
                : value;
            return Value.obj(out);
          })
        : wrongArguments(site, "Record.union"),
    ),
    "effect/Record:intersection": onRecord(
      "Record.intersection",
      3,
      (fields, [that, combine], site) =>
        that?._tag === "Obj" && !that.brand && combine
          ? Effect.gen(function* () {
              const out: Record<string, V> = {};
              for (const [key, value] of Object.entries(fields))
                if (Object.hasOwn(that.fields, key))
                  out[key] = yield* host.call(combine, [value, that.fields[key]!], site);
              return Value.obj(out);
            })
          : wrongArguments(site, "Record.intersection"),
    ),
    // The keys only one of the two has.
    "effect/Record:difference": onRecord("Record.difference", 2, (fields, [that], site) =>
      that?._tag === "Obj" && !that.brand
        ? Effect.succeed(
            record([
              ...Object.entries(fields).filter(([key]) => !Object.hasOwn(that.fields, key)),
              ...Object.entries(that.fields).filter(([key]) => !Object.hasOwn(fields, key)),
            ]),
          )
        : wrongArguments(site, "Record.difference"),
    ),
    "effect/Record:modify": onRecord("Record.modify", 3, (fields, [key, fn], site) =>
      Effect.gen(function* () {
        const name = yield* keyed("Record.modify", key, site);
        const f = yield* fnOf("Record.modify", fn, site);
        if (!Object.hasOwn(fields, name)) return Value.none;
        return Value.some(
          Value.obj({ ...fields, [name]: yield* host.call(f, [fields[name]!], site) }),
        );
      }),
    ),
    "effect/Record:replace": onRecord("Record.replace", 3, (fields, [key, value], site) =>
      Effect.map(keyed("Record.replace", key, site), (name) =>
        Object.hasOwn(fields, name)
          ? Value.some(Value.obj({ ...fields, [name]: value ?? Value.undef }))
          : Value.none,
      ),
    ),
    "effect/Record:pop": onRecord("Record.pop", 2, (fields, [key], site) =>
      Effect.map(keyed("Record.pop", key, site), (name) =>
        Object.hasOwn(fields, name)
          ? Value.some(
              pair(fields[name]!, record(Object.entries(fields).filter(([own]) => own !== name))),
            )
          : Value.none,
      ),
    ),
  };

  const structs: Models = {
    "effect/Struct:get": dual("Struct.get", 2, ([self, key], site) =>
      self
        ? Effect.flatMap(keyed("Struct.get", key, site), (name) => host.member(self, name, site))
        : wrongArguments(site, "Struct.get"),
    ),
    "effect/Struct:keys": onRecord("Struct.keys", 1, (fields) =>
      Effect.succeed(arr(Object.keys(fields).map(Value.str))),
    ),
    "effect/Struct:assign": onRecord("Struct.assign", 2, (fields, [that], site) =>
      that?._tag === "Obj" && !that.brand
        ? Effect.succeed(Value.obj({ ...fields, ...that.fields }))
        : wrongArguments(site, "Struct.assign"),
    ),
    // Each key the second object names is changed by the function under it.
    "effect/Struct:evolve": onRecord("Struct.evolve", 2, (fields, [changes], site) =>
      changes?._tag === "Obj"
        ? Effect.gen(function* () {
            const out: Record<string, V> = { ...fields };
            for (const [key, change] of Object.entries(changes.fields))
              if (Object.hasOwn(fields, key))
                out[key] = yield* host.call(change, [fields[key]!], site);
            return Value.obj(out);
          })
        : wrongArguments(site, "Struct.evolve"),
    ),
    "effect/Struct:renameKeys": onRecord("Struct.renameKeys", 2, (fields, [names], site) =>
      names?._tag === "Obj"
        ? Effect.succeed(
            record(
              Object.entries(fields).map(([key, value]) => [str(names.fields[key]) ?? key, value]),
            ),
          )
        : wrongArguments(site, "Struct.renameKeys"),
    ),
    "effect/Tuple:make": (args) => Effect.succeed(arr(args)),
    "effect/Tuple:get": dual("Tuple.get", 2, ([self, index], site) => {
      const items = kit.itemsOf(self);
      return items
        ? Effect.map(counted("Tuple.get", index, site), (at) => items[at] ?? Value.undef)
        : wrongArguments(site, "Tuple.get");
    }),
    "effect/Tuple:appendElement": dual("Tuple.appendElement", 2, ([self, item], site) => {
      const items = kit.itemsOf(self);
      return items
        ? Effect.succeed(arr([...items, item ?? Value.undef]))
        : wrongArguments(site, "Tuple.appendElement");
    }),
    "effect/Tuple:appendElements": dual("Tuple.appendElements", 2, ([self, that], site) => {
      const items = kit.itemsOf(self);
      const others = kit.itemsOf(that);
      return items && others
        ? Effect.succeed(arr([...items, ...others]))
        : wrongArguments(site, "Tuple.appendElements");
    }),
  };

  return { models: { ...arrays, ...records, ...structs } as Models, among, has, dedupe };
};
