import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as PubSub from "effect/PubSub";
import * as Pull from "effect/Pull";
import type * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxSubscriptionRef from "effect/TxSubscriptionRef";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, dualBy, native, tagOf, wrongArguments } from "../Kit.ts";
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
    kind: "Queue" | "PubSub" | "Subscription" | "TxSubscriptionRef",
    v: V | undefined,
  ) => A | undefined;
  readonly plainOf: (v: V | undefined) => unknown;
  readonly exitOf: (timeline: Timeline.Timeline, exit: Exit.Exit<unknown, unknown>) => Eval<V>;
  readonly sure: <A>(self: Effect.Effect<A, Held>) => Effect.Effect<A>;
  readonly wrap: (kind: "Queue" | "PubSub", held: unknown) => V;
  /** A cause of the code, as one the library holds. */
  readonly realCause: (cause: V | undefined) => Cause.Cause<Held> | undefined;
  /** What the code died with, of a defect the library holds. */
  readonly defectOf: (defect: unknown) => V | undefined;
}

/**
 * Streams over time, and streams run together: `Stream.tick`, `debounce`,
 * `merge`, `mapEffect` with a concurrency, a stream of a queue. As with an
 * effect that waits, none is rewritten here. A stream of the code is handed
 * to the library as one of its own, the library's function is applied, and
 * what it gives is read back, on the handler's timeline.
 */
export const make = (
  kit: Kit,
  base: Models,
  tools: Tools,
  wiring: {
    /** An effect with services provided around it. */
    readonly providing: <A>(
      provided: ReadonlyArray<readonly [service: unknown, value: V]>,
      self: Eval<A>,
    ) => Eval<A>;
    /** An effect with only these services provided while it runs. */
    readonly replacing: <A>(
      provided: ReadonlyArray<readonly [service: unknown, value: V]>,
      self: Eval<A>,
    ) => Eval<A>;
    /** Every service provided now, as a context of the code. */
    readonly context: () => V;
    /** What a layer or a context the code gives provides, built now. */
    readonly provides: (
      name: string,
      given: V | undefined,
      site: Site,
    ) => Eval<ReadonlyArray<readonly [service: unknown, value: V]>>;
  },
) => {
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

  /**
   * A function of the code the library calls at once, for a number: it is
   * run where it stands. One that an input decides cannot be, and stops the
   * prover.
   */
  const atOnce =
    (timeline: Timeline.Timeline, fn: V, site: Site) =>
    (chunk: ReadonlyArray<V>): number => {
      const cost = ranNow(fn, [arr(chunk)], site);
      if (cost?._tag === "Num") return cost.value;
      timeline.fatal ??= Value.notTranslated(
        site,
        "calls Stream.throttle with a cost the prover cannot work out at once",
      );
      return 0;
    };

  /** What a function of the code gives, run at once: nothing where it cannot be. */
  const ranNow = (fn: V, args: ReadonlyArray<V>, site: Site): V | undefined => {
    try {
      return host.atOnce(fn, args, site);
    } catch {
      return undefined;
    }
  };

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
    // The cost of a chunk is asked for at once, so it is what the function gives of values it can see.
    "effect/Stream:throttle": on("Stream.throttle", (timeline, self, [given], site) => {
      const fields = given?._tag === "Obj" && !given.brand ? given.fields : undefined;
      const cost = fields?.cost;
      if (!fields || !cost || !callable(cost)) return wrongArguments(site, "Stream.throttle");
      return Effect.gen(function* () {
        const units = yield* tools.count("Stream.throttle", fields.units, site);
        const duration = yield* tools.written("Stream.throttle", fields.duration, site);
        const burst =
          fields.burst && fields.burst._tag !== "Undef"
            ? yield* tools.count("Stream.throttle", fields.burst, site)
            : undefined;
        const strategy = fields.strategy?._tag === "Str" ? fields.strategy.value : undefined;
        if (strategy !== undefined && strategy !== "enforce" && strategy !== "shape")
          return yield* wrongArguments(site, "Stream.throttle");
        return flow(
          timeline,
          Stream.throttle(self, {
            cost: atOnce(timeline, cost, site),
            units,
            duration,
            burst,
            strategy,
          }),
          site,
          same,
        );
      });
    }),
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

  // ---- More of `Stream`, each the library's own, given the code's functions and streams.

  /** What the models of one function hand the library, for the handler that runs the stream. */
  const handing = (timeline: Timeline.Timeline, name: string, site: Site) => {
    const wrong = <A>(): Effect.Effect<A, Held> =>
      Timeline.real(timeline, wrongArguments(site, name));
    /** A function of the code that gives an effect or a plain value. */
    const fn =
      (f: V | undefined) =>
      (...args: ReadonlyArray<V>): Effect.Effect<V, Held> =>
        f && callable(f)
          ? Timeline.real(
              timeline,
              Effect.flatMap(host.call(f, args, site), (made) =>
                made._tag === "Effect" ? made.run : Effect.succeed(made),
              ),
            )
          : wrong();
    const test =
      (f: V | undefined) =>
      (...args: ReadonlyArray<V>): Effect.Effect<boolean, Held> =>
        Effect.flatMap(fn(f)(...args), (v) => Timeline.real(timeline, host.decide(v, site)));
    const eff = (v: V | undefined): Effect.Effect<V, Held> =>
      tools.effectOf(timeline, v, site) ?? wrong();
    /** A stream the code gives, or one a function of the code gives. */
    const sub = (v: V | undefined): Real =>
      isFlow(v) ? real(timeline, v) : Stream.unwrap(Effect.as(wrong<never>(), Stream.empty));
    const inner =
      (f: V | undefined) =>
      (...args: ReadonlyArray<V>): Real =>
        Stream.unwrap(Effect.map(fn(f)(...args), sub));
    const cause = (failed: Cause.Cause<unknown>): Effect.Effect<V, Held> =>
      Effect.map(Timeline.real(timeline, tools.exitOf(timeline, Exit.failCause(failed))), (exit) =>
        exit._tag === "Obj" ? (exit.fields.cause ?? Value.undef) : Value.undef,
      );
    const exit = (ended: Exit.Exit<unknown, unknown>): Effect.Effect<V, Held> =>
      Timeline.real(timeline, tools.exitOf(timeline, ended));
    const read = <A>(self: Eval<A>): Effect.Effect<A, Held> => Timeline.real(timeline, self);
    return { timeline, name, site, wrong, fn, test, eff, sub, inner, cause, exit, read };
  };
  type Handing = ReturnType<typeof handing>;

  /** A function of a stream that gives a stream: the library's, on the stream as its own. */
  const lift = (
    name: string,
    build: (to: Handing, self: Real, rest: ReadonlyArray<V>) => Stream.Stream<V, unknown>,
  ): Model =>
    on(name, (timeline, self, rest, site) =>
      Effect.sync(() =>
        flow(timeline, build(handing(timeline, name, site), self, rest), site, same),
      ),
    );
  /** A function of two streams. */
  const lift2 = (
    name: string,
    build: (
      to: Handing,
      self: Real,
      that: Real,
      rest: ReadonlyArray<V>,
    ) => Stream.Stream<V, unknown>,
  ): Model =>
    pairing(name, (timeline, self, that, rest, site) =>
      Effect.sync(() =>
        flow(timeline, build(handing(timeline, name, site), self, that, rest), site, same),
      ),
    );
  /** A stream made of values the code has, when it is opened. */
  const source =
    (
      name: string,
      build: (to: Handing, args: ReadonlyArray<V>) => Stream.Stream<V, unknown>,
    ): Model =>
    (args, site) =>
      Effect.succeed(
        timed(name, site, (timeline) =>
          Effect.sync(() => flow(timeline, build(handing(timeline, name, site), args), site, same)),
        ),
      );
  /** An effect of a stream. */
  const ran_ = (
    name: string,
    body: (to: Handing, self: Real, rest: ReadonlyArray<V>) => Effect.Effect<V, unknown>,
  ): Model =>
    dualBy(name, isFlow, ([self, ...rest], site) =>
      isFlow(self)
        ? Effect.succeed<V>({
            _tag: "Effect",
            run: Effect.flatMap(Timeline.current(site, `runs ${name}`), (timeline) =>
              Timeline.back(
                timeline,
                body(handing(timeline, name, site), real(timeline, self), rest),
                same,
              ),
            ),
          })
        : wrongArguments(site, name),
    );
  const failing = (rejection: V): Stream.Stream<never, Held> =>
    Stream.fail(new Value.Rejected({ rejection }));
  const rejectionOf = (error: unknown): V =>
    typeof error === "object" && error !== null && "_tag" in error && error._tag === "Rejected"
      ? (error as Held).rejection
      : Timeline.errorOf(error);
  /** A function of an error of the code, given the error the library holds. */
  const failed =
    <A>(use: (rejection: V) => A) =>
    (error: unknown): A =>
      use(rejectionOf(error));
  const field = (v: V | undefined, key: string): V | undefined =>
    v?._tag === "Obj" ? v.fields[key] : undefined;
  const readOptions = <A>(v: V | undefined): A | undefined =>
    v === undefined || v._tag === "Undef" ? undefined : (tools.plainOf(v) as A | undefined);

  Object.assign(models, {
    "effect/Stream:isStream": ([value]: ReadonlyArray<V>) =>
      Effect.succeed(Value.bool(isFlow(value))),
    "effect/Stream:ensuring": lift("Stream.ensuring", (to, self, [effect]) =>
      Stream.ensuring(self, tools.sure(to.eff(effect))),
    ),
    "effect/Stream:onExit": lift("Stream.onExit", (to, self, [f]) =>
      Stream.onExit(self, (ended) =>
        tools.sure(Effect.flatMap(to.exit(ended), (held) => to.fn(f)(held))),
      ),
    ),
    "effect/Stream:onEnd": lift("Stream.onEnd", (to, self, [effect]) =>
      Stream.onEnd(self, to.eff(effect)),
    ),
    "effect/Stream:onStart": lift("Stream.onStart", (to, self, [effect]) =>
      Stream.onStart(self, to.eff(effect)),
    ),
    "effect/Stream:onFirst": lift("Stream.onFirst", (to, self, [f]) =>
      Stream.onFirst(self, (item) => to.fn(f)(item)),
    ),
    "effect/Stream:onError": lift("Stream.onError", (to, self, [f]) =>
      Stream.onError(self, (cause) =>
        tools.sure(Effect.flatMap(to.cause(cause), (held) => to.fn(f)(held))),
      ),
    ),
    "effect/Stream:tapError": lift("Stream.tapError", (to, self, [f]) =>
      Stream.tapError(self, failed(to.fn(f))),
    ),
    "effect/Stream:tapCause": lift("Stream.tapCause", (to, self, [f]) =>
      Stream.tapCause(self, (cause) => Effect.flatMap(to.cause(cause), (held) => to.fn(f)(held))),
    ),
    "effect/Stream:tapBoth": lift("Stream.tapBoth", (to, self, [given]) =>
      Stream.tapBoth(self, {
        onElement: (item) => to.fn(field(given, "onElement"))(item),
        onError: failed(to.fn(field(given, "onError"))),
      }),
    ),
    "effect/Stream:catchCause": lift("Stream.catchCause", (to, self, [f]) =>
      Stream.catchCause(self, (cause) =>
        Stream.unwrap(Effect.map(to.cause(cause), (held) => to.inner(f)(held))),
      ),
    ),
    "effect/Stream:catchCauseIf": lift("Stream.catchCauseIf", (to, self, [test, f]) =>
      Stream.catchCause(self, (cause) =>
        Stream.unwrap(
          Effect.flatMap(to.cause(cause), (held) =>
            Effect.map(to.test(test)(held), (holds): Stream.Stream<V, unknown> =>
              holds ? to.inner(f)(held) : Stream.failCause(cause),
            ),
          ),
        ),
      ),
    ),
    "effect/Stream:ignore": lift("Stream.ignore", (_, self) => Stream.ignore(self)),
    "effect/Stream:ignoreCause": lift("Stream.ignoreCause", (to, self) =>
      Stream.catchCause(self, (cause) => Stream.unwrap(Effect.as(to.cause(cause), Stream.empty))),
    ),
    "effect/Stream:mapBoth": lift("Stream.mapBoth", (to, self, [given]) =>
      Stream.mapEffect(
        Stream.catch(self, (error) => {
          const mapped = failed(to.fn(field(given, "onError")))(error);
          return Stream.unwrap(Effect.map(mapped, failing));
        }),
        (item) => to.fn(field(given, "onElement"))(item),
      ),
    ),
    "effect/Stream:result": lift("Stream.result", (_, self) =>
      Stream.map(Stream.result(self), (result) =>
        Result.isSuccess(result)
          ? Brands.success(result.success)
          : failed(Brands.failure)(result.failure),
      ),
    ),
    "effect/Stream:flatten": lift("Stream.flatten", (to, self, [given]) =>
      Stream.flatten(Stream.map(self, to.sub), readOptions(given)),
    ),
    "effect/Stream:flattenEffect": lift("Stream.flattenEffect", (to, self, [given]) =>
      Stream.flattenEffect(
        Stream.map(self, (item) => to.eff(item)),
        readOptions(given),
      ),
    ),
    "effect/Stream:flattenIterable": lift("Stream.flattenIterable", (to, self) =>
      Stream.flattenIterable(
        Stream.mapEffect(self, (item) => to.read(tools.items(to.name, item, to.site))),
      ),
    ),
    "effect/Stream:flattenArray": lift("Stream.flattenArray", (to, self) =>
      Stream.flattenIterable(
        Stream.mapEffect(self, (item) => to.read(tools.items(to.name, item, to.site))),
      ),
    ),
    "effect/Stream:switchMap": lift("Stream.switchMap", (to, self, [f, given]) =>
      Stream.switchMap(self, (item) => to.inner(f)(item), readOptions(given)),
    ),
    "effect/Stream:forever": lift("Stream.forever", (_, self) => Stream.forever(self)),
    "effect/Stream:scanEffect": lift("Stream.scanEffect", (to, self, [initial, f]) =>
      Stream.unwrap(
        Effect.map(to.fn(initial)(), (first) =>
          Stream.scanEffect(
            self,
            () => first,
            (state, item) => to.fn(f)(state, item),
          ),
        ),
      ),
    ),
    "effect/Stream:mapAccumEffect": lift("Stream.mapAccumEffect", (to, self, [initial, f]) =>
      Stream.unwrap(
        Effect.map(to.fn(initial)(), (first) =>
          Stream.mapAccumEffect(
            self,
            () => first,
            (state: V, item) =>
              Effect.flatMap(to.fn(f)(state, item), (pair) =>
                Effect.gen(function* () {
                  const [next, out] = yield* to.read(tools.items(to.name, pair, to.site));
                  const values = yield* to.read(tools.items(to.name, out, to.site));
                  return [next ?? Value.undef, values] as const;
                }),
              ),
          ),
        ),
      ),
    ),
    "effect/Stream:takeWhileEffect": lift("Stream.takeWhileEffect", (to, self, [f]) =>
      Stream.takeWhileEffect(self, (item, index) => to.test(f)(item, Value.num(index))),
    ),
    "effect/Stream:takeUntilEffect": lift("Stream.takeUntilEffect", (to, self, [f, given]) =>
      Stream.takeUntilEffect(
        self,
        (item, index) => to.test(f)(item, Value.num(index)),
        readOptions(given),
      ),
    ),
    "effect/Stream:dropWhileEffect": lift("Stream.dropWhileEffect", (to, self, [f]) =>
      Stream.dropWhileEffect(self, (item, index) => to.test(f)(item, Value.num(index))),
    ),
    "effect/Stream:dropUntilEffect": lift("Stream.dropUntilEffect", (to, self, [f]) =>
      Stream.dropUntilEffect(self, (item, index) => to.test(f)(item, Value.num(index))),
    ),
    "effect/Stream:dropUntil": lift("Stream.dropUntil", (to, self, [f]) =>
      Stream.dropUntilEffect(self, (item, index) => to.test(f)(item, Value.num(index))),
    ),
    "effect/Stream:dropRight": on("Stream.dropRight", (timeline, self, [n], site) =>
      Effect.map(tools.count("Stream.dropRight", n, site), (count) =>
        flow(timeline, Stream.dropRight(self, count), site, same),
      ),
    ),
    "effect/Stream:intersperse": lift("Stream.intersperse", (_, self, [element]) =>
      Stream.intersperse(self, element ?? Value.undef),
    ),
    "effect/Stream:intersperseAffixes": lift("Stream.intersperseAffixes", (_, self, [given]) =>
      Stream.intersperseAffixes(self, {
        start: field(given, "start") ?? Value.undef,
        middle: field(given, "middle") ?? Value.undef,
        end: field(given, "end") ?? Value.undef,
      }),
    ),
    "effect/Stream:sliding": on("Stream.sliding", (timeline, self, [n], site) =>
      Effect.map(tools.count("Stream.sliding", n, site), (size) =>
        flow(timeline, Stream.sliding(self, size), site, (window): V => arr([...window])),
      ),
    ),
    "effect/Stream:chunks": on("Stream.chunks", (timeline, self, _, site) =>
      Effect.sync(() => flow(timeline, Stream.chunks(self), site, (chunk): V => arr([...chunk]))),
    ),
    "effect/Stream:repeatElements": lift("Stream.repeatElements", (to, self, [given]) => {
      const held = tools.scheduleOf(given);
      return held
        ? Stream.repeatElements(self, held)
        : Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty));
    }),
    "effect/Stream:timeoutOrElse": on("Stream.timeoutOrElse", (timeline, self, [given], site) =>
      Effect.map(tools.written("Stream.timeoutOrElse", field(given, "duration"), site), (time) => {
        const to = handing(timeline, "Stream.timeoutOrElse", site);
        return flow(
          timeline,
          Stream.timeoutOrElse(self, {
            duration: time,
            orElse: () => to.inner(field(given, "orElse"))(),
          }),
          site,
          same,
        );
      }),
    ),
    "effect/Stream:mergeEffect": lift("Stream.mergeEffect", (to, self, [effect]) =>
      Stream.mergeEffect(self, to.eff(effect)),
    ),
    "effect/Stream:orElseIfEmpty": lift("Stream.orElseIfEmpty", (to, self, [f]) =>
      Stream.orElseIfEmpty(self, () => to.inner(f)()),
    ),
    "effect/Stream:interleave": lift2("Stream.interleave", (_, self, that) =>
      Stream.interleave(self, that),
    ),
    "effect/Stream:mergeLeft": lift2("Stream.mergeLeft", (_, self, that) =>
      Stream.mergeLeft(self, that),
    ),
    "effect/Stream:mergeRight": lift2("Stream.mergeRight", (_, self, that) =>
      Stream.mergeRight(self, that),
    ),
    "effect/Stream:cross": lift2("Stream.cross", (_, self, that) =>
      Stream.map(Stream.cross(self, that), ([left, right]): V => arr([left, right])),
    ),
    "effect/Stream:crossWith": lift2("Stream.crossWith", (to, self, that, [f]) =>
      Stream.mapEffect(Stream.cross(self, that), ([left, right]) => to.fn(f)(left, right)),
    ),
    "effect/Stream:bindTo": lift("Stream.bindTo", (to, self, [name]) =>
      name?._tag === "Str"
        ? Stream.map(self, (item): V => Value.obj({ [name.value]: item }))
        : Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty)),
    ),
    "effect/Stream:bind": lift("Stream.bind", (to, self, [name, f, given]) =>
      name?._tag === "Str"
        ? Stream.flatMap(
            self,
            (item) =>
              Stream.map(to.inner(f)(item), (made): V =>
                Value.obj({ ...(item._tag === "Obj" ? item.fields : {}), [name.value]: made }),
              ),
            readOptions(given),
          )
        : Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty)),
    ),
    "effect/Stream:let": lift("Stream.let", (to, self, [name, f]) =>
      name?._tag === "Str"
        ? Stream.mapEffect(self, (item) =>
            Effect.map(to.fn(f)(item), (made): V =>
              Value.obj({ ...(item._tag === "Obj" ? item.fields : {}), [name.value]: made }),
            ),
          )
        : Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty)),
    ),
    "effect/Stream:fromEffectDrain": source("Stream.fromEffectDrain", (to, [effect]) =>
      Stream.fromEffectDrain(to.eff(effect)),
    ),
    "effect/Stream:fromEffectRepeat": source("Stream.fromEffectRepeat", (to, [effect]) =>
      Stream.fromEffectRepeat(to.eff(effect)),
    ),
    "effect/Stream:fromEffectSchedule": source(
      "Stream.fromEffectSchedule",
      (to, [effect, given]) => {
        const held = tools.scheduleOf(given);
        return held
          ? Stream.fromEffectSchedule(to.eff(effect), held)
          : Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty));
      },
    ),
    "effect/Stream:failSync": source("Stream.failSync", (to, [f]) =>
      Stream.unwrap(Effect.map(to.fn(f)(), failing)),
    ),
    "effect/Stream:fromArrays": source("Stream.fromArrays", (to, args) =>
      Stream.unwrap(
        Effect.map(
          Effect.forEach(args, (each) => to.read(tools.items(to.name, each, to.site))),
          (all) => Stream.fromIterable(all.flat()),
        ),
      ),
    ),
    "effect/Stream:runForEachArray": ran_("Stream.runForEachArray", (to, self, [f]) =>
      Effect.as(
        Stream.runForEachArray(self, (chunk) => to.fn(f)(arr(chunk))),
        Value.undef,
      ),
    ),
    "effect/Stream:runIntoQueue": ran_("Stream.runIntoQueue", (to, self, [queue]) => {
      const held = tools.heldOf<Queue.Queue<V, Held | Cause.Done>>("Queue", queue);
      return held ? Effect.as(Stream.runIntoQueue(self, held), Value.undef) : to.wrong<V>();
    }),
  });

  // ---- Yet more of `Stream`.

  const wrongStream = (to: Handing): Stream.Stream<never, Held> =>
    Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty));
  /** A function of the code, called for what it gives: an effect it gives is a value, and is not run. */
  const straight =
    (to: Handing, f: V | undefined) =>
    (...args: ReadonlyArray<V>): Effect.Effect<V, Held> =>
      f && callable(f) ? to.read(host.call(f, args, to.site)) : to.wrong();
  const option = (value: Option.Option<V>): V =>
    Option.isSome(value) ? Value.some(value.value) : Value.none;
  const some = (to: Handing, v: V): Effect.Effect<readonly [V, ...Array<V>], Held> =>
    Effect.flatMap(to.read(tools.items(to.name, v, to.site)), (all) =>
      all.length > 0 ? Effect.succeed(all as readonly [V, ...Array<V>]) : to.wrong(),
    );
  /** A state and the values to give, of the pair a function of the code gives. */
  const stepped = (to: Handing, pair: V): Effect.Effect<readonly [V, ReadonlyArray<V>], Held> =>
    Effect.gen(function* () {
      const [next, out] = yield* to.read(tools.items(to.name, pair, to.site));
      const values = yield* to.read(tools.items(to.name, out, to.site));
      return [next ?? Value.undef, values] as const;
    });
  const unset = (v: V | undefined): boolean => v === undefined || v._tag === "Undef";
  const tagged = (rejection: V, tags: V | undefined): boolean => {
    const tag = rejection._tag === "Obj" ? rejection.fields._tag : undefined;
    const wanted = tags?._tag === "Arr" ? tags.items : tags ? [tags] : [];
    return tag?._tag === "Str" && wanted.some((w) => w._tag === "Str" && w.value === tag.value);
  };
  /** An effect of a stream that makes what lives in a scope. */
  const scoped_ = (
    name: string,
    body: (
      to: Handing,
      self: Real,
      rest: ReadonlyArray<V>,
    ) => Effect.Effect<V, unknown, Scope.Scope>,
  ): Model =>
    dualBy(name, isFlow, ([self, ...rest], site) =>
      isFlow(self)
        ? Effect.succeed<V>({
            _tag: "Effect",
            run: Effect.gen(function* () {
              const timeline = yield* Timeline.current(site, `calls ${name}`);
              const scope = yield* Effect.serviceOption(Scope.Scope);
              if (Option.isNone(scope))
                return yield* Value.notTranslated(site, `calls ${name} outside Effect.scoped`);
              return yield* Timeline.back(
                timeline,
                Effect.provideService(
                  body(handing(timeline, name, site), real(timeline, self), rest),
                  Scope.Scope,
                  scope.value,
                ),
                same,
              );
            }),
          })
        : wrongArguments(site, name),
    );

  const interleaveWith = lift2("Stream.interleaveWith", (to, self, that, [decider]) =>
    Stream.interleaveWith(
      self,
      that,
      Stream.mapEffect(to.sub(decider), (v) => to.read(host.decide(v, to.site))),
    ),
  );

  Object.assign(models, {
    "effect/Stream:zipLeft": lift2("Stream.zipLeft", (_, self, that) => Stream.zipLeft(self, that)),
    "effect/Stream:zipRight": lift2("Stream.zipRight", (_, self, that) =>
      Stream.zipRight(self, that),
    ),
    "effect/Stream:zipFlatten": lift2("Stream.zipFlatten", (to, self, that) =>
      Stream.mapEffect(Stream.zip(self, that), ([left, right]) =>
        Effect.map(to.read(tools.items(to.name, left, to.site)), (all): V => arr([...all, right])),
      ),
    ),
    "effect/Stream:zipWithNext": lift("Stream.zipWithNext", (_, self) =>
      Stream.map(Stream.zipWithNext(self), ([item, next]): V => arr([item, option(next)])),
    ),
    "effect/Stream:zipWithPrevious": lift("Stream.zipWithPrevious", (_, self) =>
      Stream.map(Stream.zipWithPrevious(self), ([before, item]): V => arr([option(before), item])),
    ),
    "effect/Stream:zipWithPreviousAndNext": lift("Stream.zipWithPreviousAndNext", (_, self) =>
      Stream.map(Stream.zipWithPreviousAndNext(self), ([before, item, next]): V =>
        arr([option(before), item, option(next)]),
      ),
    ),
    "effect/Stream:zipLatestWith": lift2("Stream.zipLatestWith", (to, self, that, [f]) =>
      Stream.mapEffect(Stream.zipLatest(self, that), ([left, right]) =>
        straight(to, f)(left, right),
      ),
    ),
    "effect/Stream:zipLatestAll": source("Stream.zipLatestAll", (to, args) =>
      Stream.map(Stream.zipLatestAll(...args.map(to.sub)), (all): V => arr(all)),
    ),
    "effect/Stream:raceAll": source("Stream.raceAll", (to, args) =>
      Stream.raceAll(...args.map(to.sub)),
    ),
    // Three streams: the first is the one `pipe` gives when there are two.
    "effect/Stream:interleaveWith": (args: ReadonlyArray<V>, site: Site) =>
      args.length === 2
        ? Effect.succeed(
            native("Stream.interleaveWith", ([self], at) =>
              interleaveWith([self ?? Value.undef, ...args], at),
            ),
          )
        : interleaveWith(args, site),
    "effect/Stream:when": lift("Stream.when", (to, self, [test]) =>
      Stream.when(
        self,
        Effect.flatMap(to.eff(test), (v) => to.read(host.decide(v, to.site))),
      ),
    ),
    "effect/Stream:failCause": source("Stream.failCause", (to, [cause]) => {
      const held = tools.realCause(cause);
      return held ? Stream.failCause(held) : wrongStream(to);
    }),
    "effect/Stream:failCauseSync": source("Stream.failCauseSync", (to, [f]) =>
      Stream.unwrap(
        Effect.map(straight(to, f)(), (cause) => {
          const held = tools.realCause(cause);
          return held ? Stream.failCause(held) : wrongStream(to);
        }),
      ),
    ),
    "effect/Stream:catchDefect": lift("Stream.catchDefect", (to, self, [f]) =>
      Stream.catchDefect(self, (defect): Stream.Stream<V, unknown> => {
        const held = tools.defectOf(defect);
        return held ? to.inner(f)(held) : Stream.die(defect);
      }),
    ),
    "effect/Stream:tapDefect": lift("Stream.tapDefect", (to, self, [f]) =>
      Stream.tapDefect(self, (defect) => {
        const held = tools.defectOf(defect);
        return held ? to.fn(f)(held) : Effect.succeed(Value.undef);
      }),
    ),
    "effect/Stream:tapErrorTag": lift("Stream.tapErrorTag", (to, self, [tags, f]) =>
      Stream.tapError(
        self,
        failed((rejection) =>
          tagged(rejection, tags) ? to.fn(f)(rejection) : Effect.succeed(Value.undef),
        ),
      ),
    ),
    "effect/Stream:mapArray": lift("Stream.mapArray", (to, self, [f]) =>
      Stream.mapArrayEffect(self, (chunk, index) =>
        Effect.flatMap(straight(to, f)(arr(chunk), Value.num(index)), (out) => some(to, out)),
      ),
    ),
    "effect/Stream:mapArrayEffect": lift("Stream.mapArrayEffect", (to, self, [f]) =>
      Stream.mapArrayEffect(self, (chunk, index) =>
        Effect.flatMap(to.fn(f)(arr(chunk), Value.num(index)), (out) => some(to, out)),
      ),
    ),
    "effect/Stream:mapAccumArray": lift("Stream.mapAccumArray", (to, self, [initial, f, given]) =>
      unset(given)
        ? Stream.unwrap(
            Effect.map(straight(to, initial)(), (first) =>
              Stream.mapAccumArrayEffect(
                self,
                () => first,
                (state: V, chunk) =>
                  Effect.flatMap(straight(to, f)(state, arr(chunk)), (pair) => stepped(to, pair)),
              ),
            ),
          )
        : wrongStream(to),
    ),
    "effect/Stream:mapAccumArrayEffect": lift(
      "Stream.mapAccumArrayEffect",
      (to, self, [initial, f, given]) =>
        unset(given)
          ? Stream.unwrap(
              Effect.map(straight(to, initial)(), (first) =>
                Stream.mapAccumArrayEffect(
                  self,
                  () => first,
                  (state: V, chunk) =>
                    Effect.flatMap(to.fn(f)(state, arr(chunk)), (pair) => stepped(to, pair)),
                ),
              ),
            )
          : wrongStream(to),
    ),
    "effect/Stream:bufferArray": lift("Stream.bufferArray", (to, self, [given]) => {
      const options = readOptions<never>(given);
      return options ? Stream.bufferArray(self, options) : wrongStream(to);
    }),
    "effect/Stream:changesWithEffect": lift("Stream.changesWithEffect", (to, self, [f]) =>
      Stream.changesWithEffect(self, (x, y) => to.test(f)(x, y)),
    ),
    "effect/Stream:drainFork": lift2("Stream.drainFork", (_, self, that) =>
      Stream.drainFork(self, that),
    ),
    "effect/Stream:mergeResult": lift2("Stream.mergeResult", (_, self, that) =>
      Stream.map(Stream.mergeResult(self, that), (result) =>
        Result.isSuccess(result) ? Brands.success(result.success) : Brands.failure(result.failure),
      ),
    ),
    "effect/Stream:scoped": lift("Stream.scoped", (_, self) => Stream.scoped(self)),
    "effect/Stream:slidingSize": on("Stream.slidingSize", (timeline, self, [n, step], site) =>
      Effect.flatMap(tools.count("Stream.slidingSize", n, site), (size) =>
        Effect.map(tools.count("Stream.slidingSize", step, site), (by) =>
          flow(timeline, Stream.slidingSize(self, size, by), site, (window): V => arr([...window])),
        ),
      ),
    ),
    "effect/Stream:accumulate": lift("Stream.accumulate", (_, self) =>
      Stream.map(Stream.accumulate(self), (all): V => arr([...all])),
    ),
    "effect/Stream:collect": lift("Stream.collect", (_, self) =>
      Stream.map(Stream.collect(self), (all): V => arr([...all])),
    ),
    "effect/Stream:bindEffect": lift("Stream.bindEffect", (to, self, [name, f, given]) =>
      name?._tag === "Str"
        ? Stream.mapEffect(
            self,
            (item) =>
              Effect.flatMap(to.fn(f)(item), (value) =>
                item._tag === "Obj" && !item.brand
                  ? Effect.succeed<V>(Value.obj({ ...item.fields, [name.value]: value }))
                  : to.wrong<V>(),
              ),
            readOptions(given),
          )
        : wrongStream(to),
    ),
    "effect/Stream:throttleEffect": on("Stream.throttleEffect", (timeline, self, [given], site) => {
      const fields = given?._tag === "Obj" && !given.brand ? given.fields : undefined;
      const cost = fields?.cost;
      if (!fields || !cost || !callable(cost)) return wrongArguments(site, "Stream.throttleEffect");
      const to = handing(timeline, "Stream.throttleEffect", site);
      return Effect.gen(function* () {
        const units = yield* tools.count("Stream.throttleEffect", fields.units, site);
        const duration = yield* tools.written("Stream.throttleEffect", fields.duration, site);
        const burst = unset(fields.burst)
          ? undefined
          : yield* tools.count("Stream.throttleEffect", fields.burst, site);
        const strategy = fields.strategy?._tag === "Str" ? fields.strategy.value : undefined;
        if (strategy !== undefined && strategy !== "enforce" && strategy !== "shape")
          return yield* wrongArguments(site, "Stream.throttleEffect");
        return flow(
          timeline,
          Stream.throttleEffect(self, {
            cost: (chunk) =>
              Effect.flatMap(to.fn(cost)(arr(chunk)), (v) =>
                v._tag === "Num"
                  ? Effect.succeed(v.value)
                  : to.read(
                      Value.notTranslated(
                        site,
                        "gives Stream.throttleEffect a cost that an input decides",
                      ),
                    ),
              ),
            units,
            duration,
            burst,
            strategy,
          }),
          site,
          same,
        );
      });
    }),
    "effect/Stream:runIntoPubSub": ran_("Stream.runIntoPubSub", (to, self, [pubsub, given]) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      return held
        ? Effect.as(Stream.runIntoPubSub(self, held, readOptions(given)), Value.undef)
        : to.wrong<V>();
    }),
    "effect/Stream:toQueue": scoped_("Stream.toQueue", (to, self, [given]) => {
      const options = readOptions<never>(given);
      return options
        ? Effect.map(Stream.toQueue(self, options), (queue) => tools.wrap("Queue", queue))
        : to.wrong<V>();
    }),
    "effect/Stream:toPubSub": scoped_("Stream.toPubSub", (to, self, [given]) => {
      const options = readOptions<never>(given);
      return options
        ? Effect.map(Stream.toPubSub(self, options), (pubsub) => tools.wrap("PubSub", pubsub))
        : to.wrong<V>();
    }),
    "effect/Stream:broadcastN": scoped_("Stream.broadcastN", (to, self, [given]) => {
      const options = readOptions<never>(given);
      return options
        ? Effect.map(
            Stream.broadcastN(self, options),
            (all: ReadonlyArray<Stream.Stream<V, unknown>>): V =>
              arr(all.map((each) => flow(to.timeline, each, to.site, same))),
          )
        : to.wrong<V>();
    }),
  });

  // ---- Filters: a function of the code that passes an item on, or turns it away.

  /** The `Result` a filter of the code gave, as the library's. */
  const sorted = (to: Handing, made: V): Effect.Effect<Result.Result<V, V>, Held> => {
    const read = Brands.resultOf(made);
    if (!read) return to.wrong();
    return Effect.succeed(
      read._tag === "Success" ? Result.succeed(read.success) : Result.fail(read.failure),
    );
  };
  const passes = (to: Handing, filter: V | undefined) => (item: V) =>
    Effect.map(
      Effect.flatMap(straight(to, filter)(item), (made) => sorted(to, made)),
      Result.isSuccess,
    );
  const parted = (
    name: string,
    by: (to: Handing, filter: V | undefined) => (item: V) => Effect.Effect<V, Held>,
  ): Model =>
    scoped_(name, (to, self, [filter, given]) =>
      Effect.map(
        Stream.partitionEffect(
          self,
          (item) => Effect.flatMap(by(to, filter)(item), (made) => sorted(to, made)),
          readOptions(given),
        ),
        ([passed, failed_]): V =>
          arr([
            flow(to.timeline, passed, to.site, same),
            flow(to.timeline, failed_, to.site, same),
          ]),
      ),
    );

  Object.assign(models, {
    "effect/Stream:filterMapEffect": lift("Stream.filterMapEffect", (to, self, [filter]) =>
      Stream.filterMapEffect(self, (item) =>
        Effect.flatMap(to.fn(filter)(item), (made) => sorted(to, made)),
      ),
    ),
    // Each item the filter passes on, as the filter gives it, until one it turns away.
    "effect/Stream:takeWhileFilter": lift("Stream.takeWhileFilter", (to, self, [filter]) =>
      Stream.mapEffect(Stream.takeWhileEffect(self, passes(to, filter)), (item) =>
        Effect.flatMap(
          Effect.flatMap(straight(to, filter)(item), (made) => sorted(to, made)),
          (made) => (Result.isSuccess(made) ? Effect.succeed(made.success) : to.wrong<V>()),
        ),
      ),
    ),
    "effect/Stream:dropWhileFilter": lift("Stream.dropWhileFilter", (to, self, [filter]) =>
      Stream.dropWhileEffect(self, passes(to, filter)),
    ),
    "effect/Stream:catchFilter": lift("Stream.catchFilter", (to, self, [filter, f, orElse]) =>
      Stream.catch(
        self,
        failed((rejection) =>
          Stream.unwrap(
            Effect.map(
              Effect.flatMap(straight(to, filter)(rejection), (made) => sorted(to, made)),
              (made): Stream.Stream<V, unknown> => {
                if (Result.isSuccess(made)) return to.inner(f)(made.success);
                return unset(orElse) ? failing(made.failure) : to.inner(orElse)(made.failure);
              },
            ),
          ),
        ),
      ),
    ),
    "effect/Stream:partition": parted("Stream.partition", straight),
    // A queue of what the filter passes on, and one of what it turns away.
    "effect/Stream:partitionQueue": scoped_("Stream.partitionQueue", (to, self, [filter, given]) =>
      !filter
        ? to.wrong<V>()
        : Effect.map(
            Stream.partitionQueue(
              self,
              (item: V) => {
                const made_ = ranNow(filter, [item], to.site);
                const read = made_ ? Brands.resultOf(made_) : undefined;
                if (read)
                  return read._tag === "Success"
                    ? Result.succeed(read.success)
                    : Result.fail(read.failure);
                to.timeline.fatal ??= Value.notTranslated(
                  to.site,
                  "calls Stream.partitionQueue with a filter the prover cannot run at once",
                );
                return Result.fail(item);
              },
              readOptions(given),
            ),
            ([passed, failed_]): V =>
              arr([tools.wrap("Queue", passed), tools.wrap("Queue", failed_)]),
          ),
    ),
    "effect/Stream:partitionEffect": parted("Stream.partitionEffect", (to, filter) =>
      to.fn(filter),
    ),
  });

  // ---- Streams cut where a function of the code says, and streams that read a service.

  type Provided = ReadonlyArray<readonly [service: unknown, value: V]>;
  /** A stream with services provided while it is opened and while it is pulled. */
  const within = (self: Flow, provided: Eval<Provided>): Flow => ({
    _tag: "Stream",
    open: Effect.flatMap(provided, (held) =>
      wiring.providing(
        held,
        Effect.map(self.open, (pull) => wiring.providing(held, pull)),
      ),
    ),
  });
  const serviceOf = (name: string, tag: V | undefined, site: Site): Eval<unknown> =>
    tag?._tag === "Host" ? Effect.succeed(tag.value) : wrongArguments(site, name);
  /** A function of a stream that says what is provided to it. */
  const provided = (
    name: string,
    held: (rest: ReadonlyArray<V>, site: Site) => Eval<Provided>,
  ): Model =>
    dualBy(name, isFlow, ([self, ...rest], site) =>
      isFlow(self) ? Effect.succeed(within(self, held(rest, site))) : wrongArguments(site, name),
    );
  const reasonOf = (rejection: V, tag: V | undefined): V | undefined =>
    tag?._tag === "Str" && tagOf(rejection) === tag.value && rejection._tag === "Obj"
      ? rejection.fields.reason
      : undefined;
  /** A stream that goes on as another where its error holds a reason, and fails as it did where it does not. */
  const byReason = (
    name: string,
    next: (
      to: Handing,
      reason: V,
      error: V,
      rest: ReadonlyArray<V>,
    ) => Stream.Stream<V, unknown> | undefined,
  ): Model =>
    lift(name, (to, self, [errorTag, ...rest]) =>
      Stream.catch(
        self,
        failed((rejection): Stream.Stream<V, unknown> => {
          const reason = reasonOf(rejection, errorTag);
          return (reason && next(to, reason, rejection, rest)) ?? failing(rejection);
        }),
      ),
    );

  Object.assign(models, {
    // Cut at each item the function holds of: the items between two of them, where there are any.
    "effect/Stream:split": lift("Stream.split", (to, self, [test]) =>
      Stream.mapAccumArrayEffect(
        self,
        (): ReadonlyArray<V> => [],
        (kept, chunk) =>
          Effect.gen(function* () {
            let run = [...kept];
            const out: Array<V> = [];
            for (const item of chunk) {
              if (!(yield* to.test(test)(item))) run.push(item);
              else if (run.length > 0) {
                out.push(arr(run));
                run = [];
              }
            }
            return [run, out] as const;
          }),
        { onHalt: (kept) => (kept.length > 0 ? [arr(kept)] : []) },
      ),
    ),
    // Items that follow one another with the same key, as one group.
    "effect/Stream:groupAdjacentBy": lift("Stream.groupAdjacentBy", (to, self, [f]) =>
      Stream.mapAccumEffect(
        self,
        (): readonly [V, ReadonlyArray<V>] | undefined => undefined,
        (group, item) =>
          Effect.gen(function* () {
            const key = yield* straight(to, f)(item);
            if (!group) return [[key, [item]] as const, []] as const;
            const same_ = yield* to.read(
              Effect.flatMap(host.equal(key, group[0], to.site), (equal) =>
                host.decide(equal, to.site),
              ),
            );
            return same_
              ? ([[group[0], [...group[1], item]] as const, []] as const)
              : ([[key, [item]] as const, [arr([group[0], arr(group[1])])]] as const);
          }),
        { onHalt: (group) => (group ? [arr([group[0], arr(group[1])])] : []) },
      ),
    ),
    "effect/Stream:fromIterableEffectRepeat": source(
      "Stream.fromIterableEffectRepeat",
      (to, [effect]) =>
        Stream.fromIterableEffectRepeat(
          Effect.flatMap(to.eff(effect), (given) => to.read(tools.items(to.name, given, to.site))),
        ),
    ),
    "effect/Stream:catchCauseFilter": lift("Stream.catchCauseFilter", (to, self, [filter, f]) =>
      Stream.catchCause(self, (cause) =>
        Stream.unwrap(
          Effect.flatMap(to.cause(cause), (held) =>
            Effect.map(
              Effect.flatMap(straight(to, filter)(held), (made) => sorted(to, made)),
              (made): Stream.Stream<V, unknown> =>
                Result.isSuccess(made)
                  ? to.inner(f)(made.success, held)
                  : Stream.failCause(tools.realCause(made.failure) ?? cause),
            ),
          ),
        ),
      ),
    ),
    "effect/Stream:catchReason": byReason("Stream.catchReason", (to, reason, error, rest) => {
      const [reasonTag, f, orElse] = rest;
      if (reasonTag?._tag !== "Str") return wrongStream(to);
      if (tagOf(reason) === reasonTag.value) return to.inner(f)(reason, error);
      return unset(orElse) ? undefined : to.inner(orElse)(reason, error);
    }),
    "effect/Stream:catchReasons": byReason("Stream.catchReasons", (to, reason, error, rest) => {
      const [cases, orElse] = rest;
      if (cases?._tag !== "Obj") return wrongStream(to);
      const handler = cases.fields[tagOf(reason) ?? ""];
      if (!unset(handler)) return to.inner(handler)(reason, error);
      return unset(orElse) ? undefined : to.inner(orElse)(reason, error);
    }),
    "effect/Stream:unwrapReason": byReason("Stream.unwrapReason", (_, reason) => failing(reason)),
    "effect/Stream:service": source("Stream.service", (to, [tag]) =>
      Stream.fromEffect(
        to.read(
          Effect.flatMap(serviceOf("Stream.service", tag, to.site), (service) => {
            const given = host.provided.get(service);
            return given
              ? Effect.succeed(given)
              : Effect.fail(
                  Value.notTranslated(
                    to.site,
                    "reads Stream.service of a service that nothing provides",
                  ),
                );
          }),
        ),
      ),
    ),
    "effect/Stream:serviceOption": source("Stream.serviceOption", (to, [tag]) =>
      Stream.fromEffect(
        to.read(
          Effect.map(serviceOf("Stream.serviceOption", tag, to.site), (service) => {
            const given = host.provided.get(service);
            return given ? Value.some(given) : Value.none;
          }),
        ),
      ),
    ),
    "effect/Stream:provideService": provided("Stream.provideService", ([tag, value], site) =>
      Effect.map(serviceOf("Stream.provideService", tag, site), (service) => [
        [service, value ?? Value.undef] as const,
      ]),
    ),
    "effect/Stream:provideServiceEffect": provided(
      "Stream.provideServiceEffect",
      ([tag, effect], site) =>
        Effect.flatMap(serviceOf("Stream.provideServiceEffect", tag, site), (service) =>
          effect?._tag === "Effect"
            ? Effect.map(effect.run, (value) => [[service, value] as const])
            : wrongArguments(site, "Stream.provideServiceEffect"),
        ),
    ),
    "effect/Stream:provideContext": provided("Stream.provideContext", ([given], site) =>
      wiring.provides("Stream.provideContext", given, site),
    ),
    "effect/Stream:provide": provided("Stream.provide", ([given, options], site) =>
      unset(options)
        ? wiring.provides("Stream.provide", given, site)
        : wrongArguments(site, "Stream.provide"),
    ),
    // The stream runs with the services the function makes of the ones provided, and no others.
    "effect/Stream:updateContext": dualBy("Stream.updateContext", isFlow, ([self, f], site) =>
      isFlow(self) && f
        ? Effect.succeed<V>({
            _tag: "Stream",
            open: Effect.flatMap(
              Effect.flatMap(
                Effect.suspend(() => host.call(f, [wiring.context()], site)),
                (made_) => wiring.provides("Stream.updateContext", made_, site),
              ),
              (held) =>
                wiring.replacing(
                  held,
                  Effect.map(self.open, (pull) => wiring.replacing(held, pull)),
                ),
            ),
          })
        : wrongArguments(site, "Stream.updateContext"),
    ),
    "effect/Stream:updateService": provided("Stream.updateService", ([tag, f], site) =>
      Effect.flatMap(serviceOf("Stream.updateService", tag, site), (service) => {
        const before = host.provided.get(service);
        if (!f) return wrongArguments(site, "Stream.updateService");
        return before
          ? Effect.map(host.call(f, [before], site), (next) => [[service, next] as const])
          : Effect.fail(
              Value.notTranslated(
                site,
                "calls Stream.updateService of a service that nothing provides",
              ),
            );
      }),
    ),
  });

  // ---- Text cut into lines, and items grouped by a key the code can see.

  const textOf = (to: Handing, v: V): Effect.Effect<string, Held> => {
    const forced = host.force(v);
    return forced._tag === "Str"
      ? Effect.succeed(forced.value)
      : to.read(Value.notTranslated(to.site, `calls ${to.name} on text an input decides`));
  };
  type Keyed = string | number | boolean;
  const keyOf = (to: Handing, v: V): Effect.Effect<Keyed, Held> => {
    const forced = host.force(v);
    return forced._tag === "Str" || forced._tag === "Num" || forced._tag === "Bool"
      ? Effect.succeed(forced.value)
      : to.read(Value.notTranslated(to.site, `calls ${to.name} with a key the prover cannot see`));
  };
  const keyed = (key: Keyed): V =>
    typeof key === "string"
      ? Value.str(key)
      : typeof key === "number"
        ? Value.num(key)
        : Value.bool(key);

  Object.assign(models, {
    // What the cell holds now, then each value it is given.
    "effect/TxSubscriptionRef:changesStream": ([cell]: ReadonlyArray<V>, site: Site) => {
      const held = tools.heldOf<TxSubscriptionRef.TxSubscriptionRef<V>>("TxSubscriptionRef", cell);
      return held
        ? Effect.succeed(
            timed("TxSubscriptionRef.changesStream", site, (timeline) =>
              Effect.sync(() => flow(timeline, TxSubscriptionRef.changesStream(held), site, same)),
            ),
          )
        : wrongArguments(site, "TxSubscriptionRef.changesStream");
    },
    "effect/Stream:splitLines": lift("Stream.splitLines", (to, self) =>
      Stream.map(Stream.splitLines(Stream.mapEffect(self, (item) => textOf(to, item))), (line): V =>
        Value.str(line),
      ),
    ),
    // The key and the value of each item, from an effect of the code: a stream for each key.
    "effect/Stream:groupBy": lift("Stream.groupBy", (to, self, [f, given]) =>
      Stream.map(
        Stream.groupBy(
          self,
          (item) =>
            Effect.flatMap(to.fn(f)(item), (pair) =>
              Effect.flatMap(to.read(tools.items(to.name, pair, to.site)), ([key, value]) =>
                Effect.map(
                  keyOf(to, key ?? Value.undef),
                  (read) => [read, value ?? Value.undef] as const,
                ),
              ),
            ),
          readOptions(given),
        ),
        ([key, group]): V => arr([keyed(key), flow(to.timeline, group, to.site, same)]),
      ),
    ),
    // A stream of each key, and a stream of the items that have it.
    "effect/Stream:groupByKey": lift("Stream.groupByKey", (to, self, [f, given]) =>
      Stream.map(
        Stream.groupByKey(
          Stream.mapEffect(self, (item) =>
            Effect.map(
              Effect.flatMap(straight(to, f)(item), (key) => keyOf(to, key)),
              (key) => [key, item] as const,
            ),
          ),
          ([key]) => key,
          readOptions(given),
        ),
        ([key, group]): V =>
          arr([
            keyed(key),
            flow(
              to.timeline,
              Stream.map(group, ([, item]) => item),
              to.site,
              same,
            ),
          ]),
      ),
    ),
  });

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
    "effect/Stream:DefaultChunkSize": () => Value.num(Stream.DefaultChunkSize),
    // A stream of one empty record, for `Stream.bind` and `Stream.let` to add to.
    "effect/Stream:Do": (site) =>
      timed("Stream.Do", site, (timeline) =>
        Effect.succeed(flow(timeline, Stream.succeed<V>(Value.obj({})), site, same)),
      ),
    "effect/Stream:never": (site) =>
      timed("Stream.never", site, (timeline) =>
        Effect.succeed(flow(timeline, Stream.never, site, same)),
      ),
  };

  const lifts = { handing, lift, ran_, scoped_, straight, failed, some, flow, sorted };
  return { models, sited, real, flow, lifts };
};

/** What the models of streams are written with, for the models of what streams are run into. */
export type Lifts = ReturnType<typeof make>["lifts"];
export type Handing = ReturnType<Lifts["handing"]>;
