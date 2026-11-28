import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import * as Compare from "../Compare.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, dual, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

type Entry = readonly [key: V, value: V];

/**
 * `HashSet` and `HashMap`. A set is its items, and a map its pairs, with no
 * two items and no two keys equal on a path: whether a value is one of them
 * is a formula, and adding or removing one splits the path on it. The order
 * the library gives them in is the order of their hashes, so code that reads
 * them in order is read once for every order.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  const set = (items: ReadonlyArray<V>): V => Brands.hashSet(arr(items));
  const map = (entries: ReadonlyArray<Entry>): V =>
    Brands.hashMap(arr(entries.map(([key, value]) => arr([key, value]))));

  /** Whether two values are equal, as the library compares the items of a set: known, or a formula. */
  const equal = (a: V, b: V, site: Site): Eval<Compare.Known> => kit.equality(a, b, site);

  /** Whether two values are equal, on this path. */
  const same = (a: V, b: V, site: Site): Eval<boolean> =>
    Effect.flatMap(equal(a, b, site), (known) =>
      host.decide(Compare.fromTruth(known as boolean | string), site),
    );

  /** Whether a value is one of the items: known, or a formula. */
  const among = (items: ReadonlyArray<V>, wanted: V, site: Site): Eval<Compare.Known> =>
    Effect.map(
      Effect.forEach(items, (item) => equal(item, wanted, site)),
      Compare.any,
    );

  const within = (items: ReadonlyArray<V>, wanted: V, site: Site): Eval<boolean> =>
    Effect.flatMap(among(items, wanted, site), (known) =>
      host.decide(Compare.fromTruth(known as boolean | string), site),
    );

  const added = (items: ReadonlyArray<V>, item: V, site: Site): Eval<ReadonlyArray<V>> =>
    Effect.map(within(items, item, site), (found) => (found ? items : [...items, item]));

  const addedAll = (
    items: ReadonlyArray<V>,
    more: ReadonlyArray<V>,
    site: Site,
  ): Eval<ReadonlyArray<V>> =>
    Effect.gen(function* () {
      let out = items;
      for (const item of more) out = yield* added(out, item, site);
      return out;
    });

  /** A function of a hash set. */
  const onSet = (
    name: string,
    arity: number,
    body: (items: ReadonlyArray<V>, rest: ReadonlyArray<V>, site: Site, self: V) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const items = kit.setItems(self);
      return items && self ? body(items, rest, site, self) : wrongArguments(site, name);
    });

  /** A function of a hash map. */
  const onMap = (
    name: string,
    arity: number,
    body: (entries: ReadonlyArray<Entry>, rest: ReadonlyArray<V>, site: Site, self: V) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const entries = kit.mapEntries(self);
      return entries && self ? body(entries, rest, site, self) : wrongArguments(site, name);
    });

  const itemsOf = (name: string, v: V | undefined, site: Site): Eval<ReadonlyArray<V>> =>
    v
      ? Effect.flatMap(kit.iterate(v, site), (items) =>
          items ? Effect.succeed(items) : wrongArguments(site, name),
        )
      : wrongArguments(site, name);

  const membersOf = (name: string, v: V | undefined, site: Site): Eval<ReadonlyArray<V>> => {
    const items = kit.setItems(v);
    return items ? Effect.succeed(items) : wrongArguments(site, name);
  };

  const entriesOf = (name: string, v: V | undefined, site: Site): Eval<ReadonlyArray<Entry>> => {
    const entries = kit.mapEntries(v);
    return entries ? Effect.succeed(entries) : wrongArguments(site, name);
  };

  /** The pairs an array of them holds. */
  const pairsOf = (name: string, v: V | undefined, site: Site): Eval<ReadonlyArray<Entry>> =>
    Effect.flatMap(itemsOf(name, v, site), (items) => {
      const pairs: Array<Entry> = [];
      for (const item of items) {
        const pair = kit.itemsOf(item);
        if (!pair || pair.length !== 2) return wrongArguments(site, name);
        pairs.push([pair[0]!, pair[1]!]);
      }
      return Effect.succeed(pairs);
    });

  const fnOf = (name: string, fn: V | undefined, site: Site): Eval<V> =>
    fn ? Effect.succeed(fn) : wrongArguments(site, name);

  const formula = (
    name: string,
    parts: Eval<ReadonlyArray<boolean | string>>,
    combine: (parts: ReadonlyArray<Compare.Known>) => Compare.Known,
  ): Eval<V> => Effect.map(parts, (found) => Compare.fromTruth(combine(found) as boolean | string));

  const sets: Models = {
    "effect/HashSet:empty": () => Effect.succeed(set([])),
    "effect/HashSet:make": (args, site) => Effect.map(addedAll([], args, site), set),
    "effect/HashSet:fromIterable": ([values], site) =>
      Effect.flatMap(itemsOf("HashSet.fromIterable", values, site), (items) =>
        Effect.map(addedAll([], items, site), set),
      ),
    "effect/HashSet:isHashSet": ([value]) =>
      Effect.succeed(Value.bool(Brands.setOf(value) !== undefined)),
    "effect/HashSet:size": onSet("HashSet.size", 1, (items) =>
      Effect.succeed(Value.num(items.length)),
    ),
    "effect/HashSet:isEmpty": onSet("HashSet.isEmpty", 1, (items) =>
      Effect.succeed(Value.bool(items.length === 0)),
    ),
    "effect/HashSet:has": onSet("HashSet.has", 2, (items, [wanted], site) =>
      Effect.map(among(items, wanted ?? Value.undef, site), (known) =>
        Compare.fromTruth(known as boolean | string),
      ),
    ),
    "effect/HashSet:add": onSet("HashSet.add", 2, (items, [item], site, self) =>
      Effect.map(added(items, item ?? Value.undef, site), (out) =>
        out === items ? self : set(out),
      ),
    ),
    "effect/HashSet:remove": onSet("HashSet.remove", 2, (items, [item], site, self) =>
      Effect.gen(function* () {
        for (const [index, own] of items.entries())
          if (yield* same(own, item ?? Value.undef, site))
            return set([...items.slice(0, index), ...items.slice(index + 1)]);
        return self;
      }),
    ),
    "effect/HashSet:union": onSet("HashSet.union", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* membersOf("HashSet.union", that, site);
        return set(yield* addedAll(items, others, site));
      }),
    ),
    "effect/HashSet:intersection": onSet("HashSet.intersection", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* membersOf("HashSet.intersection", that, site);
        const out: Array<V> = [];
        for (const item of items) if (yield* within(others, item, site)) out.push(item);
        return set(out);
      }),
    ),
    "effect/HashSet:difference": onSet("HashSet.difference", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* membersOf("HashSet.difference", that, site);
        const out: Array<V> = [];
        for (const item of items) if (!(yield* within(others, item, site))) out.push(item);
        return set(out);
      }),
    ),
    // Every item of the first is one of the second: one formula.
    "effect/HashSet:isSubset": onSet("HashSet.isSubset", 2, (items, [that], site) =>
      Effect.gen(function* () {
        const others = yield* membersOf("HashSet.isSubset", that, site);
        const parts: Array<Compare.Known> = [];
        for (const item of items) parts.push(yield* among(others, item, site));
        return Compare.fromTruth(Compare.all(parts) as boolean | string);
      }),
    ),
    "effect/HashSet:map": onSet("HashSet.map", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashSet.map", fn, site);
        let out: ReadonlyArray<V> = [];
        for (const item of items) out = yield* added(out, yield* host.call(f, [item], site), site);
        return set(out);
      }),
    ),
    "effect/HashSet:filter": onSet("HashSet.filter", 2, (items, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashSet.filter", fn, site);
        const out: Array<V> = [];
        for (const item of items) if (yield* kit.holds(f, [item], site)) out.push(item);
        return set(out);
      }),
    ),
    "effect/HashSet:some": onSet("HashSet.some", 2, (items, [fn], site) =>
      fn
        ? formula(
            "HashSet.some",
            Effect.forEach(items, (item) => kit.truthOf(fn, [item], site)),
            Compare.any,
          )
        : wrongArguments(site, "HashSet.some"),
    ),
    "effect/HashSet:every": onSet("HashSet.every", 2, (items, [fn], site) =>
      fn
        ? formula(
            "HashSet.every",
            Effect.forEach(items, (item) => kit.truthOf(fn, [item], site)),
            Compare.all,
          )
        : wrongArguments(site, "HashSet.every"),
    ),
    "effect/HashSet:reduce": onSet("HashSet.reduce", 3, (items, [zero, fn], site) =>
      zero && fn
        ? Effect.gen(function* () {
            let total = zero;
            for (const item of yield* kit.inOrder("HashSet", items, site))
              total = yield* host.call(fn, [total, item], site);
            return total;
          })
        : wrongArguments(site, "HashSet.reduce"),
    ),
  };

  /** The place of a key among a map's pairs on this path, or `-1`. */
  const find = (entries: ReadonlyArray<Entry>, key: V, site: Site): Eval<number> =>
    Effect.gen(function* () {
      for (const [index, [own]] of entries.entries()) if (yield* same(own, key, site)) return index;
      return -1;
    });

  const put = (entries: ReadonlyArray<Entry>, key: V, value: V, site: Site) =>
    Effect.map(find(entries, key, site), (at): ReadonlyArray<Entry> =>
      at < 0
        ? [...entries, [key, value]]
        : [...entries.slice(0, at), [entries[at]![0], value], ...entries.slice(at + 1)],
    );

  const without = (entries: ReadonlyArray<Entry>, at: number): ReadonlyArray<Entry> =>
    at < 0 ? entries : [...entries.slice(0, at), ...entries.slice(at + 1)];

  const pairs = (entries: ReadonlyArray<Entry>): ReadonlyArray<V> =>
    entries.map(([key, value]) => arr([key, value]));

  /** A map's pairs in the order the code reads them. */
  const ordered = (entries: ReadonlyArray<Entry>, site: Site): Eval<ReadonlyArray<Entry>> =>
    Effect.map(kit.inOrder("HashMap", pairs(entries), site), (read) =>
      read.map((pair) => {
        const [key, value] = kit.itemsOf(pair)!;
        return [key!, value!] as const;
      }),
    );

  const maps: Models = {
    "effect/HashMap:empty": () => Effect.succeed(map([])),
    "effect/HashMap:make": (args, site) =>
      Effect.gen(function* () {
        let out: ReadonlyArray<Entry> = [];
        for (const [key, value] of yield* pairsOf("HashMap.make", arr(args), site))
          out = yield* put(out, key, value, site);
        return map(out);
      }),
    "effect/HashMap:fromIterable": ([given], site) =>
      Effect.gen(function* () {
        let out: ReadonlyArray<Entry> = [];
        for (const [key, value] of yield* pairsOf("HashMap.fromIterable", given, site))
          out = yield* put(out, key, value, site);
        return map(out);
      }),
    "effect/HashMap:isHashMap": ([value]) =>
      Effect.succeed(Value.bool(Brands.mapOf(value) !== undefined)),
    "effect/HashMap:size": onMap("HashMap.size", 1, (entries) =>
      Effect.succeed(Value.num(entries.length)),
    ),
    "effect/HashMap:isEmpty": onMap("HashMap.isEmpty", 1, (entries) =>
      Effect.succeed(Value.bool(entries.length === 0)),
    ),
    "effect/HashMap:has": onMap("HashMap.has", 2, (entries, [key], site) =>
      Effect.map(
        among(
          entries.map(([own]) => own),
          key ?? Value.undef,
          site,
        ),
        (known) => Compare.fromTruth(known as boolean | string),
      ),
    ),
    "effect/HashMap:get": onMap("HashMap.get", 2, (entries, [key], site) =>
      Effect.map(find(entries, key ?? Value.undef, site), (at) =>
        at < 0 ? Value.none : Value.some(entries[at]![1]),
      ),
    ),
    // A key that is not there throws, which stops the code.
    "effect/HashMap:getUnsafe": onMap("HashMap.getUnsafe", 2, (entries, [key], site) =>
      Effect.flatMap(find(entries, key ?? Value.undef, site), (at) =>
        at < 0
          ? Effect.fail(
              new Value.Rejected({
                rejection: Value.libraryError("NoSuchElementError"),
                defect: true,
              }),
            )
          : Effect.succeed(entries[at]![1]),
      ),
    ),
    "effect/HashMap:set": onMap("HashMap.set", 3, (entries, [key, value], site) =>
      Effect.map(put(entries, key ?? Value.undef, value ?? Value.undef, site), map),
    ),
    "effect/HashMap:setMany": onMap("HashMap.setMany", 2, (entries, [more], site) =>
      Effect.gen(function* () {
        let out = entries;
        for (const [key, value] of yield* pairsOf("HashMap.setMany", more, site))
          out = yield* put(out, key, value, site);
        return map(out);
      }),
    ),
    "effect/HashMap:remove": onMap("HashMap.remove", 2, (entries, [key], site, self) =>
      Effect.map(find(entries, key ?? Value.undef, site), (at) =>
        at < 0 ? self : map(without(entries, at)),
      ),
    ),
    "effect/HashMap:removeMany": onMap("HashMap.removeMany", 2, (entries, [keys], site) =>
      Effect.gen(function* () {
        let out = entries;
        for (const key of yield* itemsOf("HashMap.removeMany", keys, site))
          out = without(out, yield* find(out, key, site));
        return map(out);
      }),
    ),
    "effect/HashMap:modify": onMap("HashMap.modify", 3, (entries, [key, fn], site, self) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.modify", fn, site);
        // The function is given after the key: with it, the key is there.
        const at = yield* find(entries, key!, site);
        if (at < 0) return self;
        const [own, value] = entries[at]!;
        return map([
          ...entries.slice(0, at),
          [own, yield* host.call(f, [value], site)],
          ...entries.slice(at + 1),
        ]);
      }),
    ),
    // The function is given what is under the key, if anything, and says what is to be there.
    "effect/HashMap:modifyAt": onMap("HashMap.modifyAt", 3, (entries, [key, fn], site, self) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.modifyAt", fn, site);
        // The function is given after the key: with it, the key is there.
        const wanted = key!;
        const at = yield* find(entries, wanted, site);
        const made = Value.optionOf(
          yield* host.call(f, [at < 0 ? Value.none : Value.some(entries[at]![1])], site),
        );
        if (!made) return yield* wrongArguments(site, "HashMap.modifyAt");
        if (made._tag === "None") return at < 0 ? self : map(without(entries, at));
        return map(
          at < 0
            ? [...entries, [wanted, made.value]]
            : [...entries.slice(0, at), [entries[at]![0], made.value], ...entries.slice(at + 1)],
        );
      }),
    ),
    "effect/HashMap:union": onMap("HashMap.union", 2, (entries, [that], site) =>
      Effect.gen(function* () {
        let out = entries;
        for (const [key, value] of yield* entriesOf("HashMap.union", that, site))
          out = yield* put(out, key, value, site);
        return map(out);
      }),
    ),
    "effect/HashMap:map": onMap("HashMap.map", 2, (entries, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.map", fn, site);
        const out: Array<Entry> = [];
        for (const [key, value] of entries)
          out.push([key, yield* host.call(f, [value, key], site)]);
        return map(out);
      }),
    ),
    "effect/HashMap:filter": onMap("HashMap.filter", 2, (entries, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.filter", fn, site);
        const out: Array<Entry> = [];
        for (const [key, value] of entries)
          if (yield* kit.holds(f, [value, key], site)) out.push([key, value]);
        return map(out);
      }),
    ),
    "effect/HashMap:filterMap": onMap("HashMap.filterMap", 2, (entries, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.filterMap", fn, site);
        const out: Array<Entry> = [];
        for (const [key, value] of entries) {
          const made = Brands.resultOf(yield* host.call(f, [value, key], site));
          if (!made) return yield* wrongArguments(site, "HashMap.filterMap");
          if (made._tag === "Success") out.push([key, made.success]);
        }
        return map(out);
      }),
    ),
    "effect/HashMap:compact": onMap("HashMap.compact", 1, (entries, _, site) => {
      const out: Array<Entry> = [];
      for (const [key, value] of entries) {
        const option = Value.optionOf(value);
        if (!option) return wrongArguments(site, "HashMap.compact");
        if (option._tag === "Some") out.push([key, option.value]);
      }
      return Effect.succeed(map(out));
    }),
    "effect/HashMap:some": onMap("HashMap.some", 2, (entries, [fn], site) =>
      fn
        ? formula(
            "HashMap.some",
            Effect.forEach(entries, ([key, value]) => kit.truthOf(fn, [value, key], site)),
            Compare.any,
          )
        : wrongArguments(site, "HashMap.some"),
    ),
    "effect/HashMap:hasBy": onMap("HashMap.hasBy", 2, (entries, [fn], site) =>
      fn
        ? formula(
            "HashMap.hasBy",
            Effect.forEach(entries, ([key, value]) => kit.truthOf(fn, [value, key], site)),
            Compare.any,
          )
        : wrongArguments(site, "HashMap.hasBy"),
    ),
    "effect/HashMap:every": onMap("HashMap.every", 2, (entries, [fn], site) =>
      fn
        ? formula(
            "HashMap.every",
            Effect.forEach(entries, ([key, value]) => kit.truthOf(fn, [value, key], site)),
            Compare.all,
          )
        : wrongArguments(site, "HashMap.every"),
    ),
    "effect/HashMap:reduce": onMap("HashMap.reduce", 3, (entries, [zero, fn], site) =>
      zero && fn
        ? Effect.gen(function* () {
            let total = zero;
            for (const [key, value] of yield* ordered(entries, site))
              total = yield* host.call(fn, [total, value, key], site);
            return total;
          })
        : wrongArguments(site, "HashMap.reduce"),
    ),
    "effect/HashMap:forEach": onMap("HashMap.forEach", 2, (entries, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.forEach", fn, site);
        for (const [key, value] of yield* ordered(entries, site))
          yield* host.call(f, [value, key], site);
        return Value.undef;
      }),
    ),
    "effect/HashMap:findFirst": onMap("HashMap.findFirst", 2, (entries, [fn], site) =>
      Effect.gen(function* () {
        const f = yield* fnOf("HashMap.findFirst", fn, site);
        for (const [key, value] of yield* ordered(entries, site))
          if (yield* kit.holds(f, [value, key], site)) return Value.some(arr([key, value]));
        return Value.none;
      }),
    ),
    "effect/HashMap:keys": onMap("HashMap.keys", 1, (entries, _, site) =>
      Effect.map(ordered(entries, site), (read) => arr(read.map(([key]) => key))),
    ),
    "effect/HashMap:values": onMap("HashMap.values", 1, (entries, _, site) =>
      Effect.map(ordered(entries, site), (read) => arr(read.map(([, value]) => value))),
    ),
    "effect/HashMap:toValues": onMap("HashMap.toValues", 1, (entries, _, site) =>
      Effect.map(ordered(entries, site), (read) => arr(read.map(([, value]) => value))),
    ),
    "effect/HashMap:entries": onMap("HashMap.entries", 1, (entries, _, site) =>
      Effect.map(ordered(entries, site), (read) => arr(pairs(read))),
    ),
    "effect/HashMap:toEntries": onMap("HashMap.toEntries", 1, (entries, _, site) =>
      Effect.map(ordered(entries, site), (read) => arr(pairs(read))),
    ),
  };

  return { models: { ...sets, ...maps } as Models };
};
