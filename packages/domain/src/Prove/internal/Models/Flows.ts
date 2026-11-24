import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PubSub from "effect/PubSub";
import * as Pull from "effect/Pull";
import type * as Queue from "effect/Queue";
import type * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, dualBy, native, wrongArguments } from "../Kit.ts";
import * as Timeline from "../Timeline.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

type Flow = V & { readonly _tag: "Stream" };
type Held = Value.Rejected;
type Real = Stream.Stream<V, Held>;

const isFlow = (v: V | undefined): v is Flow => v?._tag === "Stream";

/** What `Fibers` gives to read durations, counts, schedules and functions of the code. */
export interface Tools {
  readonly span: (name: string, v: V | undefined, site: Site) => Eval<Timeline.Time>;
  readonly written: (name: string, v: V | undefined, site: Site) => Eval<Duration.Duration>;
  readonly count: (name: string, v: V | undefined, site: Site) => Eval<number>;
  readonly items: (name: string, v: V | undefined, site: Site) => Eval<ReadonlyArray<V>>;
  readonly together: (
    name: string,
    options: V | undefined,
    site: Site,
  ) => Eval<number | "unbounded" | undefined>;
  readonly flag: (options: V | undefined, key: string) => boolean;
  readonly called: (
    timeline: Timeline.Timeline,
    fn: V,
    site: Site,
  ) => (...args: ReadonlyArray<V>) => Effect.Effect<V, Held>;
  readonly effectOf: (
    timeline: Timeline.Timeline,
    v: V | undefined,
    site: Site,
  ) => Effect.Effect<V, Held> | undefined;
  readonly scheduleOf: (v: V | undefined) => Schedule.Schedule<unknown, unknown> | undefined;
  readonly heldOf: <A>(
    kind: "Queue" | "PubSub" | "Subscription",
    v: V | undefined,
  ) => A | undefined;
  readonly plainOf: (v: V | undefined) => unknown;
}

/**
 * Streams over time, and streams run together: `Stream.tick`, `debounce`,
 * `merge`, `mapEffect` with a concurrency, a stream of a queue. As with an
 * effect that waits, none is rewritten here. A stream of the code is handed
 * to the library as one of its own, the library's function is applied, and
 * what it gives is read back, on the handler's timeline.
 */
export const make = (kit: Kit, base: Models, tools: Tools) => {
  const { host } = kit;

  /** A stream of the code, as one the library runs. */
  const real = (timeline: Timeline.Timeline, self: Flow): Real =>
    Stream.fromPull(
      Effect.map(Timeline.real(timeline, self.open), (pull) => {
        const next: Effect.Effect<readonly [V, ...Array<V>], Held | Cause.Done> = Effect.flatMap(
          Timeline.real(timeline, pull),
          (chunk) =>
            chunk === undefined
              ? Cause.done()
              : chunk.length === 0
                ? next
                : Effect.succeed(chunk as readonly [V, ...Array<V>]),
        );
        return next;
      }),
    );

  /** A stream the library made, as one of the code: opened in the scope of whatever runs it. */
  const flow = <A>(
    timeline: Timeline.Timeline,
    made: Stream.Stream<A, unknown>,
    site: Site,
    give: (value: A) => V,
  ): Flow => ({
    _tag: "Stream",
    open: Effect.gen(function* () {
      const ambient = yield* Effect.serviceOption(Scope.Scope);
      const scope = Option.isSome(ambient) ? ambient.value : yield* Scope.make();
      const pull = yield* Effect.provideService(Stream.toPull(made), Scope.Scope, scope);
      return Timeline.back(
        timeline,
        Timeline.waiting(
          timeline,
          "waits for a stream that gives nothing more and does not end",
          site,
          Effect.catchCauseIf(
            Effect.map(pull, (chunk): ReadonlyArray<V> | undefined => chunk.map(give)),
            Pull.isDoneCause,
            () => Effect.succeed(undefined),
          ),
        ),
        (chunk) => chunk,
      );
    }),
  });

  const same = (value: V): V => value;

  /** A stream made on the handler's timeline, when it is opened. */
  const timed = (
    name: string,
    site: Site,
    made: (timeline: Timeline.Timeline) => Eval<Flow>,
  ): Flow => ({
    _tag: "Stream",
    open: Effect.flatMap(Timeline.current(site, `runs ${name}`), (timeline) =>
      Effect.flatMap(made(timeline), (stream) => stream.open),
    ),
  });

  /** A function of a stream, with the stream first or given it by `pipe`. */
  const on = (
    name: string,
    body: (
      timeline: Timeline.Timeline,
      self: Real,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<Flow>,
  ): Model =>
    dualBy(name, isFlow, ([self, ...rest], site) =>
      isFlow(self)
        ? Effect.succeed(
            timed(name, site, (timeline) => body(timeline, real(timeline, self), rest, site)),
          )
        : wrongArguments(site, name),
    );

  /** A function of two streams, with either first. */
  const pairing =
    (
      name: string,
      body: (
        timeline: Timeline.Timeline,
        self: Real,
        that: Real,
        rest: ReadonlyArray<V>,
        site: Site,
      ) => Eval<Flow>,
    ): Model =>
    (args, site) => {
      const [first, second, ...rest] = args;
      const both = (self: Flow, that: Flow, more: ReadonlyArray<V>, at: Site): V =>
        timed(name, at, (timeline) =>
          body(timeline, real(timeline, self), real(timeline, that), more, at),
        );
      if (isFlow(first) && isFlow(second)) return Effect.succeed(both(first, second, rest, site));
      if (!isFlow(first)) return wrongArguments(site, name);
      return Effect.succeed(
        native(name, ([self], at) =>
          isFlow(self)
            ? Effect.succeed(both(self, first, args.slice(1), at))
            : wrongArguments(at, name),
        ),
      );
    };

  const plain = (options: V | undefined): boolean =>
    options === undefined || options._tag === "Undef";

  /** One item after another, which the prover reads itself: anything else is the library's. */
  const together = (name: string, options: V | undefined, site: Site) =>
    options?._tag === "Obj" && Object.keys(options.fields).some((key) => key !== "concurrency")
      ? wrongArguments(site, name)
      : tools.together(name, options, site);

  const models: Record<string, Model> = {
    "effect/Stream:tick": ([duration], site) =>
      Effect.map(tools.written("Stream.tick", duration, site), (time) =>
        timed("Stream.tick", site, (timeline) =>
          Effect.succeed(flow(timeline, Stream.tick(time), site, () => Value.undef)),
        ),
      ),
    "effect/Stream:fromSchedule": ([schedule], site) => {
      const held = tools.scheduleOf(schedule);
      return held
        ? Effect.succeed(
            timed("Stream.fromSchedule", site, (timeline) =>
              Effect.succeed(
                flow(timeline, Stream.fromSchedule(held), site, (output) =>
                  typeof output === "number" ? Value.num(output) : Value.undef,
                ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.fromSchedule");
    },
    "effect/Stream:fromQueue": ([queue], site) => {
      const held = tools.heldOf<Queue.Queue<V, Held | Cause.Done>>("Queue", queue);
      return held
        ? Effect.succeed(
            timed("Stream.fromQueue", site, (timeline) =>
              Effect.succeed(flow(timeline, Stream.fromQueue(held), site, same)),
            ),
          )
        : wrongArguments(site, "Stream.fromQueue");
    },
    "effect/Stream:fromPubSub": ([pubsub], site) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      return held
        ? Effect.succeed(
            timed("Stream.fromPubSub", site, (timeline) =>
              Effect.succeed(flow(timeline, Stream.fromPubSub(held), site, same)),
            ),
          )
        : wrongArguments(site, "Stream.fromPubSub");
    },
    "effect/Stream:fromSubscription": ([subscription], site) => {
      const held = tools.heldOf<PubSub.Subscription<V>>("Subscription", subscription);
      return held
        ? Effect.succeed(
            timed("Stream.fromSubscription", site, (timeline) =>
              Effect.succeed(flow(timeline, Stream.fromSubscription(held), site, same)),
            ),
          )
        : wrongArguments(site, "Stream.fromSubscription");
    },
    "effect/Stream:buffer": on("Stream.buffer", (timeline, self, [options], site) => {
      const read = tools.plainOf(options) as
        | { readonly capacity?: unknown; readonly strategy?: unknown }
        | undefined;
      const capacity = read?.capacity;
      const strategy = read?.strategy;
      if (capacity === "unbounded")
        return Effect.succeed(flow(timeline, Stream.buffer(self, { capacity }), site, same));
      return typeof capacity === "number" &&
        (strategy === undefined ||
          strategy === "dropping" ||
          strategy === "sliding" ||
          strategy === "suspend")
        ? Effect.succeed(flow(timeline, Stream.buffer(self, { capacity, strategy }), site, same))
        : wrongArguments(site, "Stream.buffer");
    }),
    "effect/Stream:retry": on("Stream.retry", (timeline, self, [schedule], site) => {
      const held = tools.scheduleOf(schedule);
      return held
        ? Effect.succeed(flow(timeline, Stream.retry(self, held), site, same))
        : wrongArguments(site, "Stream.retry");
    }),
    "effect/Stream:race": pairing("Stream.race", (timeline, self, that, _, site) =>
      Effect.succeed(flow(timeline, Stream.race(self, that), site, same)),
    ),
    "effect/Stream:debounce": on("Stream.debounce", (timeline, self, [duration], site) =>
      Effect.map(tools.written("Stream.debounce", duration, site), (time) =>
        flow(timeline, Stream.debounce(self, time), site, same),
      ),
    ),
    "effect/Stream:timeout": on("Stream.timeout", (timeline, self, [duration], site) =>
      Effect.map(tools.written("Stream.timeout", duration, site), (time) =>
        flow(timeline, Stream.timeout(self, time), site, same),
      ),
    ),
    "effect/Stream:groupedWithin": on(
      "Stream.groupedWithin",
      (timeline, self, [size, duration], site) =>
        Effect.flatMap(tools.count("Stream.groupedWithin", size, site), (n) =>
          Effect.map(tools.written("Stream.groupedWithin", duration, site), (time) =>
            flow(timeline, Stream.groupedWithin(self, n, time), site, (group) => arr(group)),
          ),
        ),
    ),
    "effect/Stream:schedule": on("Stream.schedule", (timeline, self, [schedule], site) => {
      const held = tools.scheduleOf(schedule);
      return held
        ? Effect.succeed(flow(timeline, Stream.schedule(self, held), site, same))
        : wrongArguments(site, "Stream.schedule");
    }),
    "effect/Stream:repeat": on("Stream.repeat", (timeline, self, [schedule], site) => {
      const held = tools.scheduleOf(schedule);
      return held
        ? Effect.succeed(flow(timeline, Stream.repeat(self, held), site, same))
        : wrongArguments(site, "Stream.repeat");
    }),
    "effect/Stream:interruptWhen": on("Stream.interruptWhen", (timeline, self, [effect], site) => {
      const when = tools.effectOf(timeline, effect, site);
      return when
        ? Effect.succeed(flow(timeline, Stream.interruptWhen(self, when), site, same))
        : wrongArguments(site, "Stream.interruptWhen");
    }),
    "effect/Stream:haltWhen": on("Stream.haltWhen", (timeline, self, [effect], site) => {
      const when = tools.effectOf(timeline, effect, site);
      return when
        ? Effect.succeed(flow(timeline, Stream.haltWhen(self, when), site, same))
        : wrongArguments(site, "Stream.haltWhen");
    }),
    "effect/Stream:merge": pairing("Stream.merge", (timeline, self, that, [options], site) =>
      plain(options)
        ? Effect.succeed(flow(timeline, Stream.merge(self, that), site, same))
        : wrongArguments(site, "Stream.merge"),
    ),
    "effect/Stream:zipLatest": pairing("Stream.zipLatest", (timeline, self, that, _, site) =>
      Effect.succeed(flow(timeline, Stream.zipLatest(self, that), site, (pair) => arr(pair))),
    ),
    "effect/Stream:mergeAll": dualBy(
      "Stream.mergeAll",
      (v) => !(v._tag === "Obj" && !v.brand && "concurrency" in v.fields),
      ([streams, options], site) =>
        Effect.flatMap(tools.items("Stream.mergeAll", streams, site), (found) =>
          Effect.flatMap(tools.together("Stream.mergeAll", options, site), (concurrency) =>
            found.every(isFlow)
              ? Effect.succeed(
                  timed("Stream.mergeAll", site, (timeline) =>
                    Effect.succeed(
                      flow(
                        timeline,
                        Stream.mergeAll(
                          found.map((each) => real(timeline, each)),
                          { concurrency: concurrency ?? 1 },
                        ),
                        site,
                        same,
                      ),
                    ),
                  ),
                )
              : wrongArguments(site, "Stream.mergeAll"),
          ),
        ),
    ),
    "effect/Stream:mapEffect": dualBy("Stream.mapEffect", isFlow, (args, site) => {
      const [self, f, options] = args;
      const unordered = tools.flag(options, "unordered");
      const fields = options?._tag === "Obj" ? Object.keys(options.fields) : [];
      if (!fields.every((key) => key === "concurrency" || key === "unordered"))
        return wrongArguments(site, "Stream.mapEffect");
      return Effect.flatMap(tools.together("Stream.mapEffect", options, site), (concurrency) =>
        concurrency === undefined || !isFlow(self) || !f || !callable(f)
          ? base["effect/Stream:mapEffect"]!(args, site)
          : Effect.succeed(
              timed("Stream.mapEffect", site, (timeline) =>
                Effect.succeed(
                  flow(
                    timeline,
                    Stream.mapEffect(
                      real(timeline, self),
                      (item) => tools.called(timeline, f, site)(item),
                      { concurrency, unordered },
                    ),
                    site,
                    same,
                  ),
                ),
              ),
            ),
      );
    }),
    "effect/Stream:flatMap": dualBy("Stream.flatMap", isFlow, (args, site) => {
      const [self, f, options] = args;
      return Effect.flatMap(together("Stream.flatMap", options, site), (concurrency) =>
        concurrency === undefined || !isFlow(self) || !f || !callable(f)
          ? base["effect/Stream:flatMap"]!(args, site)
          : Effect.succeed(
              timed("Stream.flatMap", site, (timeline) =>
                Effect.succeed(
                  flow(
                    timeline,
                    Stream.flatMap(
                      real(timeline, self),
                      (item) =>
                        Stream.unwrap(
                          Effect.flatMap(
                            Timeline.real(timeline, host.call(f, [item], site)),
                            (inner) =>
                              isFlow(inner)
                                ? Effect.succeed(real(timeline, inner))
                                : Timeline.real(timeline, wrongArguments(site, "Stream.flatMap")),
                          ),
                        ),
                      { concurrency },
                    ),
                    site,
                    same,
                  ),
                ),
              ),
            ),
      );
    }),
  };

  /** A stream many may read, made in a scope: `Stream.broadcast` and `Stream.share`. */
  const shared = (
    name: string,
    make_: (
      self: Real,
      options: never,
    ) => Effect.Effect<Stream.Stream<V, unknown>, never, Scope.Scope>,
  ): Model =>
    dualBy(name, isFlow, ([self, options], site) => {
      const read = tools.plainOf(options);
      if (!isFlow(self) || read === undefined) return wrongArguments(site, name);
      return Effect.succeed<V>({
        _tag: "Effect",
        run: Effect.gen(function* () {
          const timeline = yield* Timeline.current(site, `calls ${name}`);
          const scope = yield* Effect.serviceOption(Scope.Scope);
          if (Option.isNone(scope))
            return yield* Value.notTranslated(site, `calls ${name} outside Effect.scoped`);
          const made = yield* Timeline.back(
            timeline,
            Effect.provideService(
              make_(real(timeline, self), read as never),
              Scope.Scope,
              scope.value,
            ),
            (stream) => stream,
          );
          return flow(timeline, made, site, same);
        }),
      });
    });

  Object.assign(models, {
    "effect/Stream:broadcast": shared("Stream.broadcast", (self, options) =>
      Stream.broadcast(self, options),
    ),
    "effect/Stream:share": shared("Stream.share", (self, options) => Stream.share(self, options)),
  });

  const sited: Readonly<Record<string, (site: Site) => V>> = {
    "effect/Stream:never": (site) =>
      timed("Stream.never", site, (timeline) =>
        Effect.succeed(flow(timeline, Stream.never, site, same)),
      ),
  };

  return { models, sited };
};
