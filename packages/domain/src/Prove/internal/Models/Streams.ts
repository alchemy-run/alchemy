import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import {
  arr,
  counted,
  dualBy,
  lazy,
  native,
  onFailure,
  tagOf,
  tagsOf,
  wrongArguments,
} from "../Kit.ts";
import type { Eval, Pull, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

type Chunk = ReadonlyArray<V>;
type Stream = V & { readonly _tag: "Stream" };

/** The most chunks one run of a stream pulls before the prover stops reading it. */
const MAX_PULLS = 10_000;

/** The items the library puts in one chunk of a stream it makes from a range. */
const CHUNK = 4096;

const END: Pull = Effect.succeed(undefined);

const stream = (open: Eval<Pull>): Stream => ({ _tag: "Stream", open });

/** A stream that is opened as `open` says, each time it is run. */
const opened = (open: () => Eval<Pull>): Stream => Effect.suspend(open).pipe(stream);

const isStream = (v: V | undefined): v is Stream => v?._tag === "Stream";

/** A stream of one chunk, or of none when there are no items. */
const fromChunk = (items: Chunk): Stream =>
  opened(() =>
    Effect.sync(() => {
      let given = items.length === 0;
      return Effect.suspend(() => {
        if (given) return END;
        given = true;
        return Effect.succeed<Chunk | undefined>(items);
      });
    }),
  );

const rejected = (rejection: V, defect = false) =>
  Effect.fail(new Value.Rejected(defect ? { rejection, defect } : { rejection }));

/**
 * `Stream`, as far as a stream is a list worked through in order: made from
 * values the code has, changed one item at a time, and run to a value.
 *
 * A stream is modelled as the library runs one. Opening it gives a pull, and
 * each pull gives the next chunk. A step that maps or filters works on a
 * whole chunk; a step that runs an effect for each item gives the items one
 * at a time. So a stream that stops early runs the effects the real one
 * runs, and no others. A stream of time, of a queue or of several fibers is
 * not read.
 */
export const make = (kit: Kit): { readonly models: Models; readonly values: Record<string, V> } => {
  const { host, ran } = kit;

  let pulls = 0;
  let depth = 0;

  /** One more chunk pulled from a stream that may never end. */
  const tick = (site: Site): Eval<void> =>
    ++pulls > MAX_PULLS
      ? Effect.fail(
          Value.notTranslated(site, `runs a stream that has not ended after ${MAX_PULLS} items`),
        )
      : Effect.void;

  /** Run a stream to its end, or until `each` says to stop. */
  const consume = (self: Stream, each: (chunk: Chunk) => Eval<boolean>, site: Site): Eval<void> =>
    Effect.suspend(() => {
      if (depth++ === 0) pulls = 0;
      return Effect.gen(function* () {
        const pull = yield* self.open;
        for (;;) {
          yield* tick(site);
          const chunk = yield* pull;
          if (chunk === undefined || !(yield* each(chunk))) return;
        }
      }).pipe(Effect.ensuring(Effect.sync(() => void depth--)));
    });

  /** A function of a stream, written with the stream first or last. */
  const over = (
    name: string,
    body: (self: Stream, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dualBy(name, isStream, ([self, ...rest], site) =>
      isStream(self) ? body(self, rest, site) : wrongArguments(site, name),
    );

  /**
   * A function of two streams, written `f(self, that, ...)` or `f(that, ...)`
   * then `self`: it is given both only when its second argument is a stream.
   */
  const pairing =
    (
      name: string,
      body: (self: Stream, that: Stream, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
    ): Model =>
    (args, site) => {
      const [first, second, ...rest] = args;
      if (isStream(first) && isStream(second)) return body(first, second, rest, site);
      if (!isStream(first)) return wrongArguments(site, name);
      return Effect.succeed(
        native(name, ([self], at) =>
          isStream(self) ? body(self, first, args.slice(1), at) : wrongArguments(at, name),
        ),
      );
    };

  /** A stream made from another by changing what its pull gives. Each opening has its own state. */
  const through = (self: Stream, change: (pull: Pull) => Pull): Stream =>
    stream(Effect.map(self.open, change));

  /** A step that works on a chunk at a time, and goes on to the next when nothing is left of one. */
  const chunked = (
    self: Stream,
    make: () => (chunk: Chunk) => Eval<Chunk | "done" | { readonly last: Chunk }>,
  ): Stream =>
    through(self, (pull) => {
      const step = make();
      let done = false;
      const pump: Pull = Effect.suspend(() =>
        done
          ? END
          : Effect.flatMap(pull, (chunk) =>
              chunk === undefined
                ? END
                : Effect.flatMap(step(chunk), (out) => {
                    if (out === "done") {
                      done = true;
                      return END;
                    }
                    if (!Array.isArray(out)) {
                      done = true;
                      const last = (out as { readonly last: Chunk }).last;
                      return last.length > 0 ? Effect.succeed<Chunk | undefined>(last) : END;
                    }
                    return out.length > 0 ? Effect.succeed<Chunk | undefined>(out) : pump;
                  }),
            ),
      );
      return pump;
    });

  /** A step that takes the items one at a time, as the steps that run an effect for each do. */
  const single = (self: Stream, each: (item: V) => Eval<V>): Stream =>
    through(self, (pull) => {
      let chunk: Chunk = [];
      let at = 0;
      const next: Pull = Effect.suspend(() => {
        if (at < chunk.length) return Effect.map(each(chunk[at++]!), (made) => [made]);
        return Effect.flatMap(pull, (pulled) => {
          if (pulled === undefined) return END;
          chunk = pulled;
          at = 0;
          return next;
        });
      });
      return next;
    });

  /** One after the other: the second is opened when the first has ended. */
  const concat = (first: Stream, second: Stream): Stream =>
    opened(() =>
      Effect.map(first.open, (pull) => {
        let current = pull;
        let moved = false;
        const next: Pull = Effect.suspend(() =>
          Effect.flatMap(current, (chunk) => {
            if (chunk !== undefined || moved) return Effect.succeed(chunk);
            moved = true;
            return Effect.flatMap(second.open, (opened) => {
              current = opened;
              return next;
            });
          }),
        );
        return next;
      }),
    );

  const streamOf = (name: string, v: V | undefined, site: Site): Eval<Stream> =>
    isStream(v) ? Effect.succeed(v) : wrongArguments(site, name);

  const fnOf = (name: string, fn: V | undefined, site: Site): Eval<V> =>
    fn ? Effect.succeed(fn) : wrongArguments(site, name);

  /** The items of an array, a hash set or a hash map, as a stream of one chunk. */
  const fromItems = (name: string, items: V | undefined, site: Site): Eval<Stream> =>
    items
      ? Effect.flatMap(kit.iterate(items, site), (found) =>
          found ? Effect.succeed(fromChunk(found)) : wrongArguments(site, name),
        )
      : wrongArguments(site, name);

  /** Whether the options ask for anything but one item after another, which is all the prover reads. */
  const sequential = (options: V | undefined): boolean => {
    if (options === undefined || options._tag === "Undef") return true;
    if (options._tag !== "Obj") return false;
    const concurrency = options.fields.concurrency;
    return (
      Object.keys(options.fields).every((key) => key === "concurrency") &&
      (concurrency === undefined ||
        concurrency._tag === "Undef" ||
        (concurrency._tag === "Num" && concurrency.value === 1))
    );
  };

  const parallel = (site: Site, name: string): Eval<never> =>
    Effect.fail(
      Value.notTranslated(
        site,
        `${name} runs more than one item at a time, which the prover does not read`,
      ),
    );

  /** A stream that goes on with another when it fails with an error the code can handle. */
  const recovering = (self: Stream, handle: (error: V) => Eval<Stream | undefined>): Stream =>
    through(self, (pull) => {
      let current = pull;
      let recovered = false;
      const next: Pull = Effect.suspend(() =>
        recovered
          ? current
          : onFailure(current, (error) =>
              Effect.flatMap(handle(error), (other) => {
                if (!other) return rejected(error);
                recovered = true;
                return Effect.flatMap(other.open, (opened) => {
                  current = opened;
                  return current;
                });
              }),
            ),
      );
      return next;
    });

  /** `Stream.unfold`: a state, and a function that gives the next item and state, or nothing at the end. */
  const unfold = (
    initial: V,
    next: (state: V, site: Site) => Eval<readonly [V, V] | undefined>,
    site: Site,
  ): Stream =>
    opened(() =>
      Effect.sync(() => {
        let state = initial;
        let done = false;
        return Effect.suspend(() =>
          done
            ? END
            : Effect.flatMap(tick(site), () =>
                Effect.map(next(state, site), (made) => {
                  if (!made) {
                    done = true;
                    return undefined;
                  }
                  state = made[1];
                  return [made[0]];
                }),
              ),
        );
      }),
    );

  const pairOf = (name: string, v: V, site: Site): Eval<readonly [V, V]> => {
    const items = kit.itemsOf(v);
    return items && items.length === 2
      ? Effect.succeed([items[0]!, items[1]!] as const)
      : wrongArguments(site, name);
  };

  /** A stream cut where a function first holds of an item, as `takeUntil` cuts it. */
  const until = (
    self: Stream,
    holds: (item: V, index: number) => Eval<boolean>,
    excludeLast: boolean,
  ): Stream =>
    through(self, (pull) => {
      let index = 0;
      let done = false;
      return Effect.suspend(() =>
        done
          ? END
          : Effect.flatMap(pull, (chunk) =>
              chunk === undefined
                ? END
                : Effect.gen(function* () {
                    for (const [at, item] of chunk.entries())
                      if (yield* holds(item, index++)) {
                        done = true;
                        const kept = chunk.slice(0, excludeLast ? at : at + 1);
                        return kept.length > 0 ? kept : undefined;
                      }
                    return chunk;
                  }),
            ),
      );
    });

  const flag = (options: V | undefined, key: string): boolean => {
    const value = options?._tag === "Obj" ? options.fields[key] : undefined;
    return value?._tag === "Bool" && value.value;
  };

  const zipWith = (left: Stream, right: Stream, combine: (a: V, b: V) => Eval<V>): Stream =>
    opened(() =>
      Effect.gen(function* () {
        const pullLeft = yield* left.open;
        const pullRight = yield* right.open;
        let a: Chunk = [];
        let b: Chunk = [];
        return Effect.gen(function* () {
          if (a.length === 0) {
            const pulled = yield* pullLeft;
            if (pulled === undefined) return undefined;
            a = pulled;
          }
          if (b.length === 0) {
            const pulled = yield* pullRight;
            if (pulled === undefined) return undefined;
            b = pulled;
          }
          const length = Math.min(a.length, b.length);
          const out: Array<V> = [];
          for (let i = 0; i < length; i++) out.push(yield* combine(a[i]!, b[i]!));
          a = a.slice(length);
          b = b.slice(length);
          return out;
        });
      }),
    );

  /** A stream's items in chunks of `size`, as `Stream.rechunk` cuts them. */
  const rechunk = (self: Stream, size: number): Stream =>
    through(self, (pull) => {
      let held: Array<V> = [];
      let current: Chunk | undefined;
      let index = 0;
      let failed: Value.Rejected | undefined;
      let done = false;
      const loop: Pull = Effect.suspend((): Pull => {
        if (failed) return Effect.fail(failed);
        if (done) return END;
        if (current === undefined)
          return Effect.flatMap(pull, (chunk) => {
            if (chunk === undefined) {
              done = true;
              const rest = held;
              held = [];
              return rest.length > 0 ? Effect.succeed<Chunk | undefined>(rest) : END;
            }
            if (held.length === 0 && chunk.length === size) return Effect.succeed(chunk);
            if (held.length + chunk.length < size) {
              held.push(...chunk);
              return loop;
            }
            current = chunk;
            return loop;
          });
        while (index < current.length) {
          held.push(current[index++]!);
          if (held.length === size) {
            const out = held;
            held = [];
            return Effect.succeed<Chunk | undefined>(out);
          }
        }
        index = 0;
        current = undefined;
        return loop;
      }).pipe(
        // What was gathered before a failure is given first, and the failure after it.
        Effect.catchTag("Rejected", (stop) => {
          if (held.length === 0) return Effect.fail(stop);
          failed = stop;
          const out = held;
          held = [];
          return Effect.succeed<Chunk | undefined>(out);
        }),
      );
      return loop;
    });

  const handlerFor =
    (name: string, tag: V | undefined, f: V | undefined, orElse: V | undefined) =>
    (site: Site) =>
    (error: V): Eval<Stream | undefined> => {
      const tags = tagsOf(tag);
      if (!tags || !f) return wrongArguments(site, name);
      const handler = tags.includes(tagOf(error) ?? "")
        ? f
        : orElse && orElse._tag !== "Undef"
          ? orElse
          : undefined;
      return handler
        ? Effect.flatMap(host.call(handler, [error], site), (made) => streamOf(name, made, site))
        : Effect.succeed(undefined);
    };

  const models: Models = {
    "effect/Stream:make": (args) => Effect.succeed(fromChunk(args)),
    "effect/Stream:succeed": ([value]) => Effect.succeed(fromChunk([value ?? Value.undef])),
    "effect/Stream:fromIterable": ([items, options], site) =>
      options === undefined || options._tag === "Undef"
        ? fromItems("Stream.fromIterable", items, site)
        : wrongArguments(site, "Stream.fromIterable"),
    "effect/Stream:fromArray": ([items], site) => fromItems("Stream.fromArray", items, site),
    "effect/Stream:fail": ([error]) =>
      Effect.succeed(opened(() => Effect.succeed(rejected(error ?? Value.undef)))),
    "effect/Stream:die": ([defect]) =>
      Effect.succeed(opened(() => Effect.succeed(rejected(defect ?? Value.undef, true)))),
    "effect/Stream:sync": ([thunk], site) =>
      thunk
        ? Effect.succeed(
            opened(() =>
              Effect.sync(() => {
                let given = false;
                return Effect.suspend(() => {
                  if (given) return END;
                  given = true;
                  return Effect.map(host.call(thunk, [], site), (value) => [value]);
                });
              }),
            ),
          )
        : wrongArguments(site, "Stream.sync"),
    "effect/Stream:fromEffect": ([self], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(
            opened(() =>
              Effect.sync(() => {
                let given = false;
                return Effect.suspend(() => {
                  if (given) return END;
                  given = true;
                  return Effect.map(self.run, (value) => [value]);
                });
              }),
            ),
          )
        : wrongArguments(site, "Stream.fromEffect"),
    "effect/Stream:fromArrayEffect": ([self], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(
            opened(() =>
              Effect.flatMap(self.run, (items) =>
                Effect.flatMap(
                  fromItems("Stream.fromArrayEffect", items, site),
                  (made) => made.open,
                ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.fromArrayEffect"),
    "effect/Stream:fromIterableEffect": ([self], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(
            opened(() =>
              Effect.flatMap(self.run, (items) =>
                Effect.flatMap(
                  fromItems("Stream.fromIterableEffect", items, site),
                  (made) => made.open,
                ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.fromIterableEffect"),
    "effect/Stream:suspend": ([thunk], site) =>
      thunk
        ? Effect.succeed(
            opened(() =>
              Effect.suspend(() =>
                Effect.flatMap(host.call(thunk, [], site), (made) =>
                  Effect.flatMap(streamOf("Stream.suspend", made, site), (inner) => inner.open),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.suspend"),
    "effect/Stream:unwrap": ([self], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(
            opened(() =>
              Effect.flatMap(self.run, (made) =>
                Effect.flatMap(streamOf("Stream.unwrap", made, site), (inner) => inner.open),
              ),
            ),
          )
        : wrongArguments(site, "Stream.unwrap"),
    "effect/Stream:range": ([min, max, size], site) =>
      Effect.gen(function* () {
        const from = yield* counted("Stream.range", min, site);
        const to = yield* counted("Stream.range", max, site);
        if (size !== undefined && size._tag !== "Undef")
          return yield* wrongArguments(site, "Stream.range");
        if (to - from > MAX_PULLS * CHUNK) return yield* wrongArguments(site, "Stream.range");
        return opened(() =>
          Effect.sync(() => {
            let start = from;
            return Effect.sync(() => {
              if (start > to) return undefined;
              const end = Math.min(to, start + CHUNK - 1);
              const chunk: Array<V> = [];
              for (let n = start; n <= end; n++) chunk.push(Value.num(n));
              start = end + 1;
              return chunk;
            });
          }),
        );
      }),
    "effect/Stream:iterate": ([value, next], site) =>
      value && next
        ? Effect.succeed(
            unfold(
              value,
              (state, at) =>
                Effect.map(host.call(next, [state], at), (after) => [state, after] as const),
              site,
            ),
          )
        : wrongArguments(site, "Stream.iterate"),
    // The function gives the next item and state, or `undefined` at the end.
    "effect/Stream:unfold": ([initial, f], site) =>
      initial && f
        ? Effect.succeed(
            unfold(
              initial,
              (state, at) =>
                Effect.flatMap(ran(f, [state], at), (made) =>
                  made._tag === "Undef"
                    ? Effect.succeed(undefined)
                    : pairOf("Stream.unfold", made, at),
                ),
              site,
            ),
          )
        : wrongArguments(site, "Stream.unfold"),
    // The function gives a page of items and the state of the next page, if there is one.
    "effect/Stream:paginate": ([initial, f], site) =>
      initial && f
        ? Effect.succeed(
            opened(() =>
              Effect.sync(() => {
                let state = initial;
                let done = false;
                const loop: Pull = Effect.suspend(() =>
                  done
                    ? END
                    : Effect.gen(function* () {
                        yield* tick(site);
                        const [page, next] = yield* pairOf(
                          "Stream.paginate",
                          yield* ran(f, [state], site),
                          site,
                        );
                        const after = Value.optionOf(next);
                        const items = kit.itemsOf(page);
                        if (!after || !items) return yield* wrongArguments(site, "Stream.paginate");
                        if (after._tag === "None") done = true;
                        else state = after.value;
                        return items.length > 0 ? items : yield* loop;
                      }),
                );
                return loop;
              }),
            ),
          )
        : wrongArguments(site, "Stream.paginate"),
    "effect/Stream:concat": pairing("Stream.concat", (self, that) =>
      Effect.succeed(concat(self, that)),
    ),
    "effect/Stream:prepend": over("Stream.prepend", (self, [values], site) =>
      Effect.map(fromItems("Stream.prepend", values, site), (first) => concat(first, self)),
    ),
    "effect/Stream:map": over("Stream.map", (self, [f], site) =>
      Effect.map(fnOf("Stream.map", f, site), (fn) =>
        chunked(self, () => {
          let index = 0;
          return (chunk) =>
            Effect.forEach(chunk, (item) => host.call(fn, [item, Value.num(index++)], site));
        }),
      ),
    ),
    "effect/Stream:as": over("Stream.as", (self, [value]) =>
      Effect.succeed(
        chunked(self, () => (chunk) => Effect.succeed(chunk.map(() => value ?? Value.undef))),
      ),
    ),
    "effect/Stream:zipWithIndex": over("Stream.zipWithIndex", (self) =>
      Effect.succeed(
        chunked(self, () => {
          let index = 0;
          return (chunk) => Effect.succeed(chunk.map((item) => arr([item, Value.num(index++)])));
        }),
      ),
    ),
    "effect/Stream:filter": over("Stream.filter", (self, [predicate], site) =>
      Effect.map(fnOf("Stream.filter", predicate, site), (fn) =>
        chunked(
          self,
          () => (chunk) =>
            Effect.gen(function* () {
              const kept: Array<V> = [];
              for (const item of chunk) if (yield* kit.holds(fn, [item], site)) kept.push(item);
              return kept;
            }),
        ),
      ),
    ),
    "effect/Stream:filterMap": over("Stream.filterMap", (self, [f], site) =>
      Effect.map(fnOf("Stream.filterMap", f, site), (fn) =>
        chunked(
          self,
          () => (chunk) =>
            Effect.gen(function* () {
              const kept: Array<V> = [];
              for (const item of chunk) {
                const made = Brands.resultOf(yield* host.call(fn, [item], site));
                if (!made) return yield* wrongArguments(site, "Stream.filterMap");
                if (made._tag === "Success") kept.push(made.success);
              }
              return kept;
            }),
        ),
      ),
    ),
    // The effect is run for every item of a chunk before any of them goes on.
    "effect/Stream:filterEffect": over("Stream.filterEffect", (self, [predicate], site) =>
      Effect.map(fnOf("Stream.filterEffect", predicate, site), (fn) =>
        chunked(
          self,
          () => (chunk) =>
            Effect.gen(function* () {
              const kept: Array<V> = [];
              for (const item of chunk)
                if (yield* host.decide(yield* ran(fn, [item], site), site)) kept.push(item);
              return kept;
            }),
        ),
      ),
    ),
    "effect/Stream:mapEffect": over("Stream.mapEffect", (self, [f, options], site) =>
      !sequential(options)
        ? parallel(site, "Stream.mapEffect")
        : Effect.map(fnOf("Stream.mapEffect", f, site), (fn) =>
            single(self, (item) => ran(fn, [item], site)),
          ),
    ),
    "effect/Stream:tap": over("Stream.tap", (self, [f, options], site) =>
      !sequential(options)
        ? parallel(site, "Stream.tap")
        : Effect.map(fnOf("Stream.tap", f, site), (fn) =>
            single(self, (item) => Effect.as(ran(fn, [item], site), item)),
          ),
    ),
    "effect/Stream:flatMap": over("Stream.flatMap", (self, [f, options], site) =>
      !sequential(options)
        ? parallel(site, "Stream.flatMap")
        : Effect.map(fnOf("Stream.flatMap", f, site), (fn) =>
            through(self, (pull) => {
              let chunk: Chunk = [];
              let at = 0;
              let inner: Pull | undefined;
              const next: Pull = Effect.suspend((): Pull => {
                if (inner)
                  return Effect.flatMap(inner, (pulled) => {
                    if (pulled !== undefined) return Effect.succeed<Chunk | undefined>(pulled);
                    inner = undefined;
                    return next;
                  });
                if (at < chunk.length)
                  return Effect.flatMap(host.call(fn, [chunk[at++]!], site), (made) =>
                    Effect.flatMap(streamOf("Stream.flatMap", made, site), (opened) =>
                      Effect.flatMap(opened.open, (opening) => {
                        inner = opening;
                        return next;
                      }),
                    ),
                  );
                return Effect.flatMap(pull, (pulled) => {
                  if (pulled === undefined) return END;
                  chunk = pulled;
                  at = 0;
                  return next;
                });
              });
              return next;
            }),
          ),
    ),
    "effect/Stream:take": over("Stream.take", (self, [n], site) =>
      Effect.map(counted("Stream.take", n, site), (count) =>
        count <= 0
          ? fromChunk([])
          : until(self, (_, index) => Effect.succeed(index === count - 1), false),
      ),
    ),
    "effect/Stream:takeUntil": over("Stream.takeUntil", (self, [predicate, options], site) =>
      Effect.map(fnOf("Stream.takeUntil", predicate, site), (fn) =>
        until(
          self,
          (item, index) => kit.holds(fn, [item, Value.num(index)], site),
          flag(options, "excludeLast"),
        ),
      ),
    ),
    "effect/Stream:takeWhile": over("Stream.takeWhile", (self, [predicate], site) =>
      Effect.map(fnOf("Stream.takeWhile", predicate, site), (fn) =>
        chunked(self, () => {
          let index = 0;
          return (chunk) =>
            Effect.gen(function* () {
              const out: Array<V> = [];
              for (const item of chunk) {
                // The first item it does not hold of ends the stream: nothing more is pulled.
                if (!(yield* kit.holds(fn, [item, Value.num(index++)], site))) return { last: out };
                out.push(item);
              }
              return out;
            });
        }),
      ),
    ),
    "effect/Stream:drop": over("Stream.drop", (self, [n], site) =>
      Effect.map(counted("Stream.drop", n, site), (count) =>
        count <= 0
          ? self
          : chunked(self, () => {
              let dropped = 0;
              return (chunk) => {
                if (dropped >= count) return Effect.succeed(chunk);
                dropped += chunk.length;
                return Effect.succeed(dropped <= count ? [] : chunk.slice(count - dropped));
              };
            }),
      ),
    ),
    "effect/Stream:dropWhile": over("Stream.dropWhile", (self, [predicate], site) =>
      Effect.map(fnOf("Stream.dropWhile", predicate, site), (fn) =>
        chunked(self, () => {
          let dropping = true;
          let index = 0;
          return (chunk) =>
            Effect.gen(function* () {
              if (!dropping) return chunk;
              for (const [at, item] of chunk.entries())
                if (!(yield* kit.holds(fn, [item, Value.num(index++)], site))) {
                  dropping = false;
                  return chunk.slice(at);
                }
              return [];
            });
        }),
      ),
    ),
    // Everything is gathered, and the last `n` given when the stream ends.
    "effect/Stream:takeRight": over("Stream.takeRight", (self, [n], site) =>
      Effect.map(counted("Stream.takeRight", n, site), (count) =>
        count <= 0
          ? fromChunk([])
          : through(self, (pull) => {
              let held: Array<V> = [];
              let done = false;
              const loop: Pull = Effect.suspend(() =>
                done
                  ? END
                  : Effect.flatMap(pull, (chunk) => {
                      if (chunk === undefined) {
                        done = true;
                        return Effect.succeed(held.length > 0 ? held : undefined);
                      }
                      held = [...held, ...chunk].slice(-count);
                      return loop;
                    }),
              );
              return loop;
            }),
      ),
    ),
    // The first value is what `initial` gives, and each one after it is the function of the one before and an item.
    "effect/Stream:scan": over("Stream.scan", (self, [initial, f], site) =>
      initial && f
        ? Effect.succeed(
            opened(() =>
              Effect.suspend(() =>
                Effect.flatMap(
                  host.call(initial, [], site),
                  (seed) =>
                    concat(
                      fromChunk([seed]),
                      chunked(self, () => {
                        let state = seed;
                        return (chunk) =>
                          Effect.forEach(chunk, (item) =>
                            Effect.map(host.call(f, [state, item], site), (after) => {
                              state = after;
                              return after;
                            }),
                          );
                      }),
                    ).open,
                ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.scan"),
    ),
    "effect/Stream:mapAccum": over("Stream.mapAccum", (self, [initial, f, options], site) =>
      initial && f && (options === undefined || options._tag === "Undef")
        ? Effect.succeed(
            opened(() =>
              Effect.suspend(() =>
                Effect.flatMap(
                  host.call(initial, [], site),
                  (seed) =>
                    chunked(self, () => {
                      let state = seed;
                      return (chunk) =>
                        Effect.gen(function* () {
                          const out: Array<V> = [];
                          for (const item of chunk) {
                            const [after, values] = yield* pairOf(
                              "Stream.mapAccum",
                              yield* host.call(f, [state, item], site),
                              site,
                            );
                            const made = kit.itemsOf(values);
                            if (!made) return yield* wrongArguments(site, "Stream.mapAccum");
                            state = after;
                            out.push(...made);
                          }
                          return out;
                        });
                    }).open,
                ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.mapAccum"),
    ),
    "effect/Stream:zip": pairing("Stream.zip", (self, that) =>
      Effect.succeed(zipWith(self, that, (a, b) => Effect.succeed(arr([a, b])))),
    ),
    "effect/Stream:zipWith": pairing("Stream.zipWith", (self, that, [f], site) =>
      Effect.map(fnOf("Stream.zipWith", f, site), (fn) =>
        zipWith(self, that, (a, b) => host.call(fn, [a, b], site)),
      ),
    ),
    // An item equal to the one before it is left out.
    "effect/Stream:changes": over("Stream.changes", (self, _, site) =>
      Effect.succeed(
        chunked(self, () => {
          let last: V | undefined;
          return (chunk) =>
            Effect.gen(function* () {
              const out: Array<V> = [];
              for (const item of chunk) {
                if (
                  last !== undefined &&
                  (yield* host.decide(yield* kit.equals(item, last, site), site))
                )
                  continue;
                last = item;
                out.push(item);
              }
              return out;
            });
        }),
      ),
    ),
    "effect/Stream:changesWith": over("Stream.changesWith", (self, [same], site) =>
      Effect.map(fnOf("Stream.changesWith", same, site), (fn) =>
        chunked(self, () => {
          let last: V | undefined;
          return (chunk) =>
            Effect.gen(function* () {
              const out: Array<V> = [];
              for (const item of chunk) {
                if (last !== undefined && (yield* kit.holds(fn, [item, last], site))) continue;
                last = item;
                out.push(item);
              }
              return out;
            });
        }),
      ),
    ),
    "effect/Stream:rechunk": over("Stream.rechunk", (self, [n], site) =>
      Effect.map(counted("Stream.rechunk", n, site), (size) => rechunk(self, Math.max(1, size))),
    ),
    "effect/Stream:grouped": over("Stream.grouped", (self, [n], site) =>
      Effect.map(counted("Stream.grouped", n, site), (size) =>
        chunked(rechunk(self, Math.max(1, size)), () => (chunk) => Effect.succeed([arr(chunk)])),
      ),
    ),
    "effect/Stream:drain": over("Stream.drain", (self) =>
      Effect.succeed(chunked(self, () => () => Effect.succeed([]))),
    ),
    "effect/Stream:catch": over("Stream.catch", (self, [f], site) =>
      Effect.map(fnOf("Stream.catch", f, site), (fn) =>
        recovering(self, (error) =>
          Effect.flatMap(host.call(fn, [error], site), (made) =>
            streamOf("Stream.catch", made, site),
          ),
        ),
      ),
    ),
    "effect/Stream:catchTag": over("Stream.catchTag", (self, [tag, f, orElse], site) =>
      Effect.succeed(recovering(self, handlerFor("Stream.catchTag", tag, f, orElse)(site))),
    ),
    "effect/Stream:catchTags": over("Stream.catchTags", (self, [cases, orElse], site) =>
      cases?._tag === "Obj"
        ? Effect.succeed(
            recovering(self, (error) => {
              const handler =
                cases.fields[tagOf(error) ?? ""] ??
                (orElse && orElse._tag !== "Undef" ? orElse : undefined);
              return handler
                ? Effect.flatMap(host.call(handler, [error], site), (made) =>
                    streamOf("Stream.catchTags", made, site),
                  )
                : Effect.succeed(undefined);
            }),
          )
        : wrongArguments(site, "Stream.catchTags"),
    ),
    "effect/Stream:catchIf": over("Stream.catchIf", (self, [predicate, f, orElse], site) =>
      predicate && f
        ? Effect.succeed(
            recovering(self, (error) =>
              Effect.flatMap(kit.holds(predicate, [error], site), (held) => {
                const handler = held ? f : orElse && orElse._tag !== "Undef" ? orElse : undefined;
                return handler
                  ? Effect.flatMap(host.call(handler, [error], site), (made) =>
                      streamOf("Stream.catchIf", made, site),
                    )
                  : Effect.succeed(undefined);
              }),
            ),
          )
        : wrongArguments(site, "Stream.catchIf"),
    ),
    "effect/Stream:orElseSucceed": over("Stream.orElseSucceed", (self, [f], site) =>
      Effect.map(fnOf("Stream.orElseSucceed", f, site), (fn) =>
        recovering(self, (error) =>
          Effect.map(host.call(fn, [error], site), (value) => fromChunk([value])),
        ),
      ),
    ),
    "effect/Stream:mapError": over("Stream.mapError", (self, [f], site) =>
      Effect.map(fnOf("Stream.mapError", f, site), (fn) =>
        through(self, (pull) =>
          onFailure(pull, (error) => Effect.flatMap(host.call(fn, [error], site), rejected)),
        ),
      ),
    ),
    "effect/Stream:orDie": over("Stream.orDie", (self) =>
      Effect.succeed(through(self, (pull) => onFailure(pull, (error) => rejected(error, true)))),
    ),
    "effect/Stream:withSpan": over("Stream.withSpan", (self) => Effect.succeed(self)),
    "effect/Stream:runCollect": over("Stream.runCollect", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.suspend(() => {
            const out: Array<V> = [];
            return Effect.as(
              consume(
                self,
                (chunk) => {
                  out.push(...chunk);
                  return Effect.succeed(true);
                },
                site,
              ),
              arr(out),
            );
          }),
        ),
      ),
    ),
    "effect/Stream:runFold": over("Stream.runFold", (self, [initial, f], site) =>
      initial && f
        ? Effect.succeed(
            lazy(() =>
              Effect.gen(function* () {
                let total = yield* host.call(initial, [], site);
                yield* consume(
                  self,
                  (chunk) =>
                    Effect.gen(function* () {
                      for (const item of chunk) total = yield* host.call(f, [total, item], site);
                      return true;
                    }),
                  site,
                );
                return total;
              }),
            ),
          )
        : wrongArguments(site, "Stream.runFold"),
    ),
    "effect/Stream:runFoldEffect": over("Stream.runFoldEffect", (self, [initial, f], site) =>
      initial && f
        ? Effect.succeed(
            lazy(() =>
              Effect.gen(function* () {
                let total = yield* host.call(initial, [], site);
                yield* consume(
                  self,
                  (chunk) =>
                    Effect.gen(function* () {
                      for (const item of chunk) total = yield* ran(f, [total, item], site);
                      return true;
                    }),
                  site,
                );
                return total;
              }),
            ),
          )
        : wrongArguments(site, "Stream.runFoldEffect"),
    ),
    "effect/Stream:runForEach": over("Stream.runForEach", (self, [f], site) =>
      f
        ? Effect.succeed(
            lazy(() =>
              Effect.as(
                consume(
                  self,
                  (chunk) =>
                    Effect.gen(function* () {
                      for (const item of chunk) yield* ran(f, [item], site);
                      return true;
                    }),
                  site,
                ),
                Value.undef,
              ),
            ),
          )
        : wrongArguments(site, "Stream.runForEach"),
    ),
    "effect/Stream:runForEachWhile": over("Stream.runForEachWhile", (self, [f], site) =>
      f
        ? Effect.succeed(
            lazy(() =>
              Effect.as(
                consume(
                  self,
                  (chunk) =>
                    Effect.gen(function* () {
                      for (const item of chunk)
                        if (!(yield* host.decide(yield* ran(f, [item], site), site))) return false;
                      return true;
                    }),
                  site,
                ),
                Value.undef,
              ),
            ),
          )
        : wrongArguments(site, "Stream.runForEachWhile"),
    ),
    // The first item of the first chunk: nothing after that chunk is pulled.
    "effect/Stream:runHead": over("Stream.runHead", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.suspend(() => {
            let head: V = Value.none;
            return Effect.as(
              consume(
                self,
                (chunk) => {
                  head = Value.some(chunk[0]!);
                  return Effect.succeed(false);
                },
                site,
              ),
              Value.undef,
            ).pipe(Effect.map(() => head));
          }),
        ),
      ),
    ),
    "effect/Stream:runLast": over("Stream.runLast", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.suspend(() => {
            let last: V = Value.none;
            return consume(
              self,
              (chunk) => {
                last = Value.some(chunk[chunk.length - 1]!);
                return Effect.succeed(true);
              },
              site,
            ).pipe(Effect.map(() => last));
          }),
        ),
      ),
    ),
    "effect/Stream:runCount": over("Stream.runCount", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.suspend(() => {
            let count = 0;
            return consume(
              self,
              (chunk) => {
                count += chunk.length;
                return Effect.succeed(true);
              },
              site,
            ).pipe(Effect.map(() => Value.num(count)));
          }),
        ),
      ),
    ),
    "effect/Stream:runSum": over("Stream.runSum", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.gen(function* () {
            let total: V = Value.num(0);
            yield* consume(
              self,
              (chunk) =>
                Effect.gen(function* () {
                  for (const item of chunk) total = yield* host.arithmetic("+", total, item, site);
                  return true;
                }),
              site,
            );
            return total;
          }),
        ),
      ),
    ),
    "effect/Stream:mkString": over("Stream.mkString", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.gen(function* () {
            let total: V = Value.str("");
            yield* consume(
              self,
              (chunk) =>
                Effect.gen(function* () {
                  for (const item of chunk) total = yield* host.arithmetic("+", total, item, site);
                  return true;
                }),
              site,
            );
            return total;
          }),
        ),
      ),
    ),
    "effect/Stream:runDrain": over("Stream.runDrain", (self, _, site) =>
      Effect.succeed(
        lazy(() =>
          Effect.as(
            consume(self, () => Effect.succeed(true), site),
            Value.undef,
          ),
        ),
      ),
    ),
  };

  // Sinks. A sink is what a stream is run into: it pulls chunks until it has what it wants.
  const sinks = new WeakMap<object, (pull: Pull, site: Site) => Eval<V>>();

  const sink = (name: string, feed: (pull: Pull, site: Site) => Eval<V>): V => {
    const made = native(name, (_, site) => wrongArguments(site, name));
    sinks.set(made, feed);
    return made;
  };

  /** A sink that takes every chunk, and keeps a state. */
  const reducing = (
    name: string,
    initial: (site: Site) => Eval<V>,
    step: (state: V, chunk: Chunk, site: Site) => Eval<V>,
  ): V =>
    sink(name, (pull, site) =>
      Effect.gen(function* () {
        let state = yield* initial(site);
        for (;;) {
          yield* tick(site);
          const chunk = yield* pull;
          if (chunk === undefined) return state;
          state = yield* step(state, chunk, site);
        }
      }),
    );

  /**
   * A sink that takes items while its state lets it go on. With `first`, the
   * state it starts with is asked too, before anything is pulled.
   */
  const reducingWhile = (
    name: string,
    first: boolean,
    initial: (site: Site) => Eval<V>,
    goesOn: (state: V, site: Site) => Eval<boolean>,
    step: (state: V, item: V, site: Site) => Eval<V>,
  ): V =>
    sink(name, (pull, site) =>
      Effect.gen(function* () {
        let state = yield* initial(site);
        if (first && !(yield* goesOn(state, site))) return state;
        for (;;) {
          yield* tick(site);
          const chunk = yield* pull;
          if (chunk === undefined) return state;
          for (const item of chunk) {
            state = yield* step(state, item, site);
            if (!(yield* goesOn(state, site))) return state;
          }
        }
      }),
    );

  const given = (value: V) => () => Effect.succeed(value);
  const isNone = (state: V) => Effect.succeed(Value.optionOf(state)?._tag === "None");
  const truthy = (state: V, site: Site) => host.decide(state, site);

  const sinkModels: Models = {
    "effect/Stream:run": over("Stream.run", (self, [into], site) => {
      const feed = into ? sinks.get(into) : undefined;
      return feed
        ? Effect.succeed(
            lazy(() =>
              Effect.suspend(() => {
                if (depth++ === 0) pulls = 0;
                return Effect.flatMap(self.open, (pull) => feed(pull, site)).pipe(
                  Effect.ensuring(Effect.sync(() => void depth--)),
                );
              }),
            ),
          )
        : wrongArguments(site, "Stream.run");
    }),
    "effect/Sink:collect": () =>
      Effect.succeed(
        reducing("Sink.collect", given(arr([])), (state, chunk) =>
          Effect.succeed(arr([...(kit.itemsOf(state) ?? []), ...chunk])),
        ),
      ),
    "effect/Sink:head": () =>
      Effect.succeed(
        reducingWhile("Sink.head", true, given(Value.none), isNone, (_, item) =>
          Effect.succeed(Value.some(item)),
        ),
      ),
    "effect/Sink:last": () =>
      Effect.succeed(
        reducing("Sink.last", given(Value.none), (_, chunk) =>
          Effect.succeed(Value.some(chunk[chunk.length - 1]!)),
        ),
      ),
    "effect/Sink:reduce": ([initial, f], site) =>
      initial && f
        ? Effect.succeed(
            reducing(
              "Sink.reduce",
              (at) => host.call(initial, [], at),
              (state, chunk, at) =>
                Effect.gen(function* () {
                  let next = state;
                  for (const item of chunk) next = yield* host.call(f, [next, item], at);
                  return next;
                }),
            ),
          )
        : wrongArguments(site, "Sink.reduce"),
    // The state is folded while the function says to go on: it is asked after each item.
    "effect/Sink:fold": ([initial, goesOn, f], site) =>
      initial && goesOn && f
        ? Effect.succeed(
            reducingWhile(
              "Sink.fold",
              false,
              (at) => host.call(initial, [], at),
              (state, at) => kit.holds(goesOn, [state], at),
              (state, item, at) => ran(f, [state, item], at),
            ),
          )
        : wrongArguments(site, "Sink.fold"),
    "effect/Sink:every": ([predicate], site) =>
      predicate
        ? Effect.succeed(
            reducingWhile("Sink.every", false, given(Value.bool(true)), truthy, (_, item, at) =>
              Effect.map(kit.holds(predicate, [item], at), Value.bool),
            ),
          )
        : wrongArguments(site, "Sink.every"),
    "effect/Sink:some": ([predicate], site) =>
      predicate
        ? Effect.succeed(
            reducingWhile(
              "Sink.some",
              false,
              given(Value.bool(false)),
              (state, at) => Effect.map(truthy(state, at), (found) => !found),
              (_, item, at) => Effect.map(kit.holds(predicate, [item], at), Value.bool),
            ),
          )
        : wrongArguments(site, "Sink.some"),
    "effect/Sink:find": ([predicate], site) =>
      predicate
        ? Effect.succeed(
            reducingWhile("Sink.find", true, given(Value.none), isNone, (state, item, at) =>
              Effect.map(kit.holds(predicate, [item], at), (found) =>
                found ? Value.some(item) : state,
              ),
            ),
          )
        : wrongArguments(site, "Sink.find"),
    "effect/Sink:take": ([n], site) =>
      Effect.map(counted("Sink.take", n, site), (count) =>
        reducingWhile(
          "Sink.take",
          true,
          given(arr([])),
          (state) => Effect.succeed((kit.itemsOf(state)?.length ?? 0) < Math.max(0, count)),
          (state, item) => Effect.succeed(arr([...(kit.itemsOf(state) ?? []), item])),
        ),
      ),
    "effect/Sink:forEach": ([f], site) =>
      f
        ? Effect.succeed(
            reducing("Sink.forEach", given(Value.undef), (_, chunk, at) =>
              Effect.gen(function* () {
                for (const item of chunk) yield* ran(f, [item], at);
                return Value.undef;
              }),
            ),
          )
        : wrongArguments(site, "Sink.forEach"),
    "effect/Sink:succeed": ([value]) =>
      Effect.succeed(sink("Sink.succeed", () => Effect.succeed(value ?? Value.undef))),
    "effect/Sink:fail": ([error]) =>
      Effect.succeed(sink("Sink.fail", () => rejected(error ?? Value.undef))),
    "effect/Sink:map": (args, site) => {
      const mapped = (self: V | undefined, f: V | undefined, at: Site): Eval<V> => {
        const feed = self ? sinks.get(self) : undefined;
        return feed && f
          ? Effect.succeed(
              sink("Sink.map", (pull, where) =>
                Effect.flatMap(feed(pull, where), (result) => host.call(f, [result], where)),
              ),
            )
          : wrongArguments(at, "Sink.map");
      };
      return args.length >= 2
        ? mapped(args[0], args[1], site)
        : Effect.succeed(native("Sink.map", ([self], at) => mapped(self, args[0], at)));
    },
  };

  const values: Record<string, V> = {
    "effect/Stream:empty": fromChunk([]),
    "effect/Sink:count": reducing("Sink.count", given(Value.num(0)), (state, chunk, site) =>
      host.arithmetic("+", state, Value.num(chunk.length), site),
    ),
    "effect/Sink:sum": reducing("Sink.sum", given(Value.num(0)), (state, chunk, site) =>
      Effect.gen(function* () {
        let total = state;
        for (const item of chunk) total = yield* host.arithmetic("+", total, item, site);
        return total;
      }),
    ),
    "effect/Sink:drain": reducing("Sink.drain", given(Value.undef), (state) =>
      Effect.succeed(state),
    ),
  };

  return { models: { ...models, ...sinkModels } as Models, values };
};
