import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as PubSub from "effect/PubSub";
import * as Pull from "effect/Pull";
import type * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, dualBy, native, wrongArguments } from "../Kit.ts";
import * as Timeline from "../Timeline.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";
import type * as Flows from "./Flows.ts";

type Held = Value.Rejected;
type Some = readonly [V, ...Array<V>];
type RealSink = Sink.Sink<V, V, V, Held>;
type End = Sink.End<V, V>;
type Handing = Flows.Handing;

/**
 * Sinks, as the library's own.
 *
 * The prover reads a few sinks itself, a chunk at a time, and that is enough
 * to run a stream into one. It is not enough for what joins two sinks, hands
 * one what another left over, or runs one again and again over a stream:
 * `Sink.flatMap`, `Stream.transduce`, `Stream.peel`. For those a sink of the
 * code is built as one of the library's, given the code's functions, and the
 * library's own function is applied on the handler's timeline.
 */
export const make = (
  kit: Kit,
  base: Models,
  constants: Readonly<Record<string, V>>,
  tools: Flows.Tools,
  flows: Flows.Lifts & {
    /** A sink the prover reads itself. */
    readonly read: (v: V) => boolean;
  },
) => {
  const { host } = kit;
  const { handing, straight, failed, some } = flows;

  const builders = new WeakMap<object, (timeline: Timeline.Timeline, at: Site) => RealSink>();
  const isSink = (v: V | undefined): v is V => v !== undefined && builders.has(v);

  /** A sink of the code: `onto` is the one the prover reads itself, when there is one. */
  const sink = (
    name: string,
    build: (to: Handing) => RealSink,
    site: Site | undefined,
    onto?: V,
  ): V => {
    const made = onto ?? native(name, (_, at) => wrongArguments(at, name));
    builders.set(made, (timeline, at) => build(handing(timeline, name, site ?? at)));
    return made;
  };
  const wrongSink = (to: Handing): RealSink => Sink.fromEffect(to.wrong<never>());
  /** The library's sink of one the code gives. */
  const built = (to: Handing, v: V | undefined): RealSink => {
    const build = v ? builders.get(v) : undefined;
    return build ? build(to.timeline, to.site) : wrongSink(to);
  };
  const rejected = (rejection: V): Held => new Value.Rejected({ rejection });
  const option = (value: Option.Option<V>): V =>
    Option.isSome(value) ? Value.some(value.value) : Value.none;
  const unset = (v: V | undefined): boolean => v === undefined || v._tag === "Undef";

  /** What a sink ends with, as the pair the code is given. */
  const endOf = (end: End): V =>
    arr(
      end.map((part, index) =>
        index === 0 ? (part as V) : part ? arr(part as Some) : Value.undef,
      ),
    );
  /** The pair the code gives, as what a sink ends with. */
  const ended = (to: Handing, pair: V): Effect.Effect<End, Held> =>
    Effect.gen(function* () {
      const [value, left] = yield* to.read(tools.items(to.name, pair, to.site));
      if (unset(left)) return [value ?? Value.undef] as const;
      const leftover = yield* to.read(tools.items(to.name, left, to.site));
      return [value ?? Value.undef, leftover.length > 0 ? (leftover as Some) : undefined] as const;
    });

  /**
   * A sink that keeps a state and asks a function of the code whether to go
   * on, an item at a time. The library's own ask at once, which a function of
   * the code that an input decides cannot answer: this is theirs, with the
   * question asked as an effect.
   */
  const folding = <S>(options: {
    readonly first: boolean;
    readonly initial: Effect.Effect<S, Held>;
    readonly goesOn: (state: S) => Effect.Effect<boolean, Held>;
    readonly step: (state: S, item: V) => Effect.Effect<S, Held>;
    readonly out: (state: S) => V;
  }): RealSink =>
    Sink.fromTransform((upstream: Pull.Pull<Some, never, void>) =>
      Effect.gen(function* () {
        let state = yield* options.initial;
        if (options.first && !(yield* options.goesOn(state))) return [options.out(state)] as End;
        return yield* Pull.catchDone(
          Effect.gen(function* () {
            for (;;) {
              const chunk = yield* upstream;
              for (let i = 0; i < chunk.length; i++) {
                state = yield* options.step(state, chunk[i]!);
                if (yield* options.goesOn(state)) continue;
                const left = chunk.slice(i + 1);
                return [
                  options.out(state),
                  left.length > 0 ? (left as unknown as Some) : undefined,
                ] as End;
              }
            }
          }),
          () => Effect.sync((): End => [options.out(state)]),
        );
      }),
    );
  /** The same, a chunk at a time: nothing is left over. */
  const foldingArray = (options: {
    readonly first: boolean;
    readonly initial: Effect.Effect<V, Held>;
    readonly goesOn: (state: V) => Effect.Effect<boolean, Held>;
    readonly step: (state: V, chunk: Some) => Effect.Effect<V, Held>;
  }): RealSink =>
    Sink.fromTransform((upstream: Pull.Pull<Some, never, void>) =>
      Effect.gen(function* () {
        let state = yield* options.initial;
        if (options.first && !(yield* options.goesOn(state))) return [state] as End;
        return yield* Pull.catchDone(
          Effect.gen(function* () {
            for (;;) {
              state = yield* options.step(state, yield* upstream);
              if (!(yield* options.goesOn(state))) return [state] as End;
            }
          }),
          () => Effect.sync((): End => [state]),
        );
      }),
    );
  const always = () => Effect.succeed(true);

  /** A sink made of what the code gives. */
  const made =
    (name: string, build: (to: Handing, args: ReadonlyArray<V>) => RealSink): Model =>
    (args, site) =>
      Effect.succeed(sink(name, (to) => build(to, args), site));
  /** One the prover reads itself too: it is both, and a stream run into it alone is read as before. */
  const both =
    (name: string, key: string, build: (to: Handing, args: ReadonlyArray<V>) => RealSink): Model =>
    (args, site) => {
      const read = base[key];
      return read
        ? Effect.map(read(args, site), (onto) => sink(name, (to) => build(to, args), site, onto))
        : made(name, build)(args, site);
    };
  /** A function of a sink, with the sink first or given it by `pipe`. */
  const on = (
    name: string,
    build: (to: Handing, self: RealSink, rest: ReadonlyArray<V>) => RealSink,
  ): Model =>
    dualBy(name, isSink, ([self, ...rest], site) =>
      isSink(self)
        ? Effect.succeed(sink(name, (to) => build(to, built(to, self), rest), site))
        : wrongArguments(site, name),
    );

  const taking = (to: Handing, test: V | undefined, until: boolean): RealSink =>
    Sink.map(
      until
        ? Sink.takeUntilEffect((item: V) => to.test(test)(item))
        : Sink.takeWhileEffect((item: V) => to.test(test)(item)),
      (all): V => arr(all),
    );
  const reducingWhile = (
    to: Handing,
    [initial, test, f]: ReadonlyArray<V>,
    step: (f: V | undefined) => (...args: ReadonlyArray<V>) => Effect.Effect<V, Held>,
    first: boolean,
  ): RealSink =>
    folding<V>({
      first,
      initial: straight(to, initial)(),
      goesOn: unset(test) ? always : (state) => to.test(test)(state),
      step: (state, item) => step(f)(state, item),
      out: (state) => state,
    });
  const reducingWhileArray = (
    to: Handing,
    [initial, test, f]: ReadonlyArray<V>,
    step: (f: V | undefined) => (...args: ReadonlyArray<V>) => Effect.Effect<V, Held>,
    first: boolean,
  ): RealSink =>
    foldingArray({
      first,
      initial: straight(to, initial)(),
      goesOn: unset(test) ? always : (state) => to.test(test)(state),
      step: (state, chunk) => step(f)(state, arr(chunk)),
    });
  const finding = (to: Handing, test: V | undefined): RealSink =>
    folding<Option.Option<V>>({
      first: true,
      initial: Effect.succeedNone,
      goesOn: (state) => Effect.sync(() => state._tag === "None"),
      step: (state, item) =>
        Effect.map(to.test(test)(item), (holds) => (holds ? Option.some(item) : state)),
      out: option,
    });
  const failingWith = (to: Handing, cause: V | undefined): RealSink => {
    const held = tools.realCause(cause);
    return held ? Sink.failCause(held) : wrongSink(to);
  };
  const pure = (to: Handing, f: V | undefined) => straight(to, f);
  const effectful = (to: Handing, f: V | undefined) => to.fn(f);

  const models: Record<string, Model> = {
    "effect/Sink:isSink": ([value]) => Effect.succeed(Value.bool(isSink(value))),

    // ---- The ones the prover reads itself too.
    "effect/Sink:collect": both("Sink.collect", "effect/Sink:collect", () =>
      Sink.map(Sink.collect<V>(), (all): V => arr(all)),
    ),
    "effect/Sink:head": both("Sink.head", "effect/Sink:head", () =>
      Sink.map(Sink.head<V>(), option),
    ),
    "effect/Sink:last": both("Sink.last", "effect/Sink:last", () =>
      Sink.map(Sink.last<V>(), option),
    ),
    "effect/Sink:reduce": both("Sink.reduce", "effect/Sink:reduce", (to, [initial, f]) =>
      reducingWhile(
        to,
        [initial ?? Value.undef, Value.undef, f ?? Value.undef],
        () => pure(to, f),
        false,
      ),
    ),
    "effect/Sink:fold": both("Sink.fold", "effect/Sink:fold", (to, args) =>
      reducingWhile(to, args, (f) => effectful(to, f), false),
    ),
    "effect/Sink:every": both("Sink.every", "effect/Sink:every", (to, [test]) =>
      folding<boolean>({
        first: false,
        initial: Effect.succeed(true),
        goesOn: (state) => Effect.succeed(state),
        step: (_, item) => to.test(test)(item),
        out: Value.bool,
      }),
    ),
    "effect/Sink:some": both("Sink.some", "effect/Sink:some", (to, [test]) =>
      folding<boolean>({
        first: false,
        initial: Effect.succeed(false),
        goesOn: (state) => Effect.succeed(!state),
        step: (_, item) => to.test(test)(item),
        out: Value.bool,
      }),
    ),
    "effect/Sink:find": both("Sink.find", "effect/Sink:find", (to, [test]) => finding(to, test)),
    "effect/Sink:take": both("Sink.take", "effect/Sink:take", (to, [n]) =>
      Sink.unwrap(
        Effect.map(to.read(tools.count("Sink.take", n, to.site)), (count) =>
          Sink.map(Sink.take<V>(count), (all): V => arr(all)),
        ),
      ),
    ),
    "effect/Sink:forEach": both("Sink.forEach", "effect/Sink:forEach", (to, [f]) =>
      Sink.as(
        Sink.forEach((item: V) => to.fn(f)(item)),
        Value.undef,
      ),
    ),
    "effect/Sink:succeed": both("Sink.succeed", "effect/Sink:succeed", (_, [value]) =>
      Sink.succeed(value ?? Value.undef),
    ),
    "effect/Sink:fail": both("Sink.fail", "effect/Sink:fail", (_, [error]) =>
      Sink.fail(rejected(error ?? Value.undef)),
    ),
    "effect/Sink:map": dualBy("Sink.map", isSink, ([self, f], site) => {
      const read = base["effect/Sink:map"];
      const build = (to: Handing): RealSink =>
        Sink.mapEffect(built(to, self), (value) => straight(to, f)(value));
      if (!isSink(self)) return wrongArguments(site, "Sink.map");
      return flows.read(self)
        ? Effect.map(read([self, f ?? Value.undef], site), (onto) =>
            sink("Sink.map", build, site, onto),
          )
        : Effect.succeed(sink("Sink.map", build, site));
    }),

    // ---- Sinks made of what the code gives.
    "effect/Sink:failSync": made("Sink.failSync", (to, [f]) =>
      Sink.unwrap(Effect.map(straight(to, f)(), (error) => Sink.fail(rejected(error)))),
    ),
    "effect/Sink:failCause": made("Sink.failCause", (to, [cause]) => failingWith(to, cause)),
    "effect/Sink:failCauseSync": made("Sink.failCauseSync", (to, [f]) =>
      Sink.unwrap(Effect.map(straight(to, f)(), (cause) => failingWith(to, cause))),
    ),
    "effect/Sink:die": made("Sink.die", (_, [defect]) =>
      Sink.die(new Timeline.Defect(defect ?? Value.undef)),
    ),
    "effect/Sink:sync": made("Sink.sync", (to, [f]) => Sink.fromEffect(straight(to, f)())),
    "effect/Sink:fromEffect": made("Sink.fromEffect", (to, [effect]) =>
      Sink.fromEffect(to.eff(effect)),
    ),
    "effect/Sink:fromEffectEnd": made("Sink.fromEffectEnd", (to, [effect]) =>
      Sink.fromEffectEnd(Effect.flatMap(to.eff(effect), (pair) => ended(to, pair))),
    ),
    "effect/Sink:fromQueue": made("Sink.fromQueue", (to, [queue]) => {
      const held = tools.heldOf<Queue.Queue<V, Cause.Done>>("Queue", queue);
      return held ? Sink.as(Sink.fromQueue(held), Value.undef) : wrongSink(to);
    }),
    "effect/Sink:fromPubSub": made("Sink.fromPubSub", (to, [pubsub]) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      return held ? Sink.as(Sink.fromPubSub(held), Value.undef) : wrongSink(to);
    }),
    "effect/Sink:suspend": made("Sink.suspend", (to, [f]) =>
      Sink.unwrap(Effect.map(straight(to, f)(), (given) => built(to, given))),
    ),
    "effect/Sink:unwrap": made("Sink.unwrap", (to, [effect]) =>
      Sink.unwrap(Effect.map(to.eff(effect), (given) => built(to, given))),
    ),
    "effect/Sink:findEffect": made("Sink.findEffect", (to, [test]) => finding(to, test)),
    "effect/Sink:takeWhile": made("Sink.takeWhile", (to, [test]) => taking(to, test, false)),
    "effect/Sink:takeWhileEffect": made("Sink.takeWhileEffect", (to, [test]) =>
      taking(to, test, false),
    ),
    "effect/Sink:takeUntil": made("Sink.takeUntil", (to, [test]) => taking(to, test, true)),
    "effect/Sink:takeUntilEffect": made("Sink.takeUntilEffect", (to, [test]) =>
      taking(to, test, true),
    ),
    "effect/Sink:takeWhileFilter": made("Sink.takeWhileFilter", (to, [filter]) =>
      Sink.map(
        Sink.takeWhileFilterEffect((item: V) =>
          Effect.flatMap(straight(to, filter)(item), (made_) => flows.sorted(to, made_)),
        ),
        (all): V => arr(all),
      ),
    ),
    "effect/Sink:takeWhileFilterEffect": made("Sink.takeWhileFilterEffect", (to, [filter]) =>
      Sink.map(
        Sink.takeWhileFilterEffect((item: V) =>
          Effect.flatMap(to.fn(filter)(item), (made_) => flows.sorted(to, made_)),
        ),
        (all): V => arr(all),
      ),
    ),
    "effect/Sink:reduceEffect": made("Sink.reduceEffect", (to, [initial, f]) =>
      reducingWhile(
        to,
        [initial ?? Value.undef, Value.undef, f ?? Value.undef],
        () => effectful(to, f),
        false,
      ),
    ),
    "effect/Sink:reduceArray": made("Sink.reduceArray", (to, [initial, f]) =>
      reducingWhileArray(to, [initial ?? Value.undef], () => pure(to, f), false),
    ),
    "effect/Sink:reduceWhile": made("Sink.reduceWhile", (to, args) =>
      reducingWhile(to, args, (f) => pure(to, f), true),
    ),
    "effect/Sink:reduceWhileEffect": made("Sink.reduceWhileEffect", (to, args) =>
      reducingWhile(to, args, (f) => effectful(to, f), true),
    ),
    "effect/Sink:reduceWhileArray": made("Sink.reduceWhileArray", (to, args) =>
      reducingWhileArray(to, args, (f) => pure(to, f), true),
    ),
    "effect/Sink:reduceWhileArrayEffect": made("Sink.reduceWhileArrayEffect", (to, args) =>
      reducingWhileArray(to, args, (f) => effectful(to, f), true),
    ),
    "effect/Sink:foldArray": made("Sink.foldArray", (to, args) =>
      reducingWhileArray(to, args, (f) => effectful(to, f), false),
    ),
    // The state, and how many items it has taken: it stops at the count.
    "effect/Sink:foldUntil": made("Sink.foldUntil", (to, [initial, max, f]) =>
      Sink.unwrap(
        Effect.map(to.read(tools.count("Sink.foldUntil", max, to.site)), (count) =>
          count === 0
            ? Sink.fromEffect(straight(to, initial)())
            : folding<readonly [V, number]>({
                first: false,
                initial: Effect.map(straight(to, initial)(), (state) => [state, 0] as const),
                goesOn: ([, taken]) => Effect.succeed(taken < count),
                step: ([state, taken], item) =>
                  Effect.map(to.fn(f)(state, item), (next) => [next, taken + 1] as const),
                out: ([state]) => state,
              }),
        ),
      ),
    ),
    "effect/Sink:forEachArray": made("Sink.forEachArray", (to, [f]) =>
      Sink.as(
        Sink.forEachArray((chunk: Some) => to.fn(f)(arr(chunk))),
        Value.undef,
      ),
    ),
    "effect/Sink:forEachWhile": made("Sink.forEachWhile", (to, [f]) =>
      Sink.as(
        Sink.forEachWhile((item: V) => to.test(f)(item)),
        Value.undef,
      ),
    ),
    "effect/Sink:forEachWhileArray": made("Sink.forEachWhileArray", (to, [f]) =>
      Sink.as(
        Sink.forEachWhileArray((chunk: Some) => to.test(f)(arr(chunk))),
        Value.undef,
      ),
    ),

    // ---- Functions of a sink.
    "effect/Sink:as": on("Sink.as", (_, self, [value]) => Sink.as(self, value ?? Value.undef)),
    "effect/Sink:mapEffect": on("Sink.mapEffect", (to, self, [f]) =>
      Sink.mapEffect(self, (value) => to.fn(f)(value)),
    ),
    "effect/Sink:mapEnd": on("Sink.mapEnd", (to, self, [f]) =>
      Sink.mapEffectEnd(self, (end) =>
        Effect.flatMap(straight(to, f)(endOf(end)), (pair) => ended(to, pair)),
      ),
    ),
    "effect/Sink:mapEffectEnd": on("Sink.mapEffectEnd", (to, self, [f]) =>
      Sink.mapEffectEnd(self, (end) =>
        Effect.flatMap(to.fn(f)(endOf(end)), (pair) => ended(to, pair)),
      ),
    ),
    "effect/Sink:mapLeftover": on("Sink.mapLeftover", (to, self, [f]) =>
      Sink.mapEffectEnd(self, ([value, left]) =>
        left
          ? Effect.map(
              Effect.forEach(left, (item) => straight(to, f)(item)),
              (mapped): End => [value, mapped as unknown as Some],
            )
          : Effect.succeed<End>([value, left]),
      ),
    ),
    "effect/Sink:ignoreLeftover": on("Sink.ignoreLeftover", (_, self) => Sink.ignoreLeftover(self)),
    "effect/Sink:mapError": on("Sink.mapError", (to, self, [f]) =>
      Sink.fromTransform((upstream: Pull.Pull<Some, never, void>, scope) =>
        Effect.catch(
          self.transform(upstream, scope),
          failed((rejection) =>
            Effect.flatMap(straight(to, f)(rejection), (mapped) => Effect.fail(rejected(mapped))),
          ),
        ),
      ),
    ),
    "effect/Sink:mapInput": on("Sink.mapInput", (to, self, [f]) =>
      Sink.mapInputEffect(self, (item: V) => straight(to, f)(item)),
    ),
    "effect/Sink:mapInputEffect": on("Sink.mapInputEffect", (to, self, [f]) =>
      Sink.mapInputEffect(self, (item: V) => to.fn(f)(item)),
    ),
    "effect/Sink:mapInputArray": on("Sink.mapInputArray", (to, self, [f]) =>
      Sink.mapInputArrayEffect(self, (chunk: Some) =>
        Effect.flatMap(straight(to, f)(arr(chunk)), (out) => some(to, out)),
      ),
    ),
    "effect/Sink:mapInputArrayEffect": on("Sink.mapInputArrayEffect", (to, self, [f]) =>
      Sink.mapInputArrayEffect(self, (chunk: Some) =>
        Effect.flatMap(to.fn(f)(arr(chunk)), (out) => some(to, out)),
      ),
    ),
    // The second sink is given what the first left over, and then the rest of the stream.
    "effect/Sink:flatMap": on("Sink.flatMap", (to, self, [f]) =>
      Sink.fromTransform((upstream: Pull.Pull<Some, never, void>, scope) => {
        let upstreamDone = false;
        const pull = Effect.catchCause(upstream, (cause) => {
          upstreamDone = true;
          return Effect.failCause(cause);
        });
        return Effect.flatMap(self.transform(pull, scope), ([value, left]) => {
          let leftover = left;
          return Effect.flatMap(straight(to, f)(value), (next) =>
            Effect.map(
              built(to, next).transform(
                Effect.suspend((): Pull.Pull<Some, never, void> => {
                  if (leftover) {
                    const chunk = leftover;
                    leftover = undefined;
                    return Effect.succeed(chunk);
                  }
                  return upstreamDone ? Cause.done() : upstream;
                }),
                scope,
              ),
              (end): End =>
                leftover ? [end[0], end[1] ? [...end[1], ...leftover] : leftover] : end,
            ),
          );
        });
      }),
    ),
    "effect/Sink:orElse": on("Sink.orElse", (to, self, [f]) =>
      Sink.fromTransform((upstream: Pull.Pull<Some, never, void>, scope) => {
        let upstreamDone = false;
        const pull = Effect.catchCause(upstream, (cause) => {
          upstreamDone = true;
          return Effect.failCause(cause);
        });
        return Effect.catch(
          self.transform(pull, scope),
          failed((rejection) =>
            Effect.flatMap(straight(to, f)(rejection), (next) =>
              built(to, next).transform(
                Effect.suspend((): Pull.Pull<Some, never, void> =>
                  upstreamDone ? Cause.done() : upstream,
                ),
                scope,
              ),
            ),
          ),
        );
      }),
    ),
    "effect/Sink:catch": on("Sink.catch", (to, self, [f]) => Sink.catch(self, failed(to.fn(f)))),
    "effect/Sink:catchCause": on("Sink.catchCause", (to, self, [f]) =>
      Sink.catchCause(self, (cause) => Effect.flatMap(to.cause(cause), (held) => to.fn(f)(held))),
    ),
    "effect/Sink:ensuring": on("Sink.ensuring", (to, self, [effect]) =>
      Sink.ensuring(self, tools.sure(to.eff(effect))),
    ),
    "effect/Sink:onExit": on("Sink.onExit", (to, self, [f]) =>
      Sink.onExit(self, (exit) =>
        tools.sure(Effect.flatMap(to.exit(exit), (held) => to.fn(f)(held))),
      ),
    ),
    // What an effect gives before the sink starts and after it ends, and a function of the two.
    "effect/Sink:summarized": on("Sink.summarized", (to, self, [summary, f]) =>
      Sink.fromTransform((upstream: Pull.Pull<Some, never, void>, scope) =>
        Effect.gen(function* () {
          const start = yield* to.eff(summary);
          const [value, left] = yield* self.transform(upstream, scope);
          const end = yield* to.eff(summary);
          const told = yield* straight(to, f)(start, end);
          return [arr([value, told]), left] as End;
        }),
      ),
    ),
  };

  // ---- A stream run into a sink, once or again and again.

  const run = flows.ran_("Stream.run", (to, self, [into]) => Stream.run(self, built(to, into)));
  Object.assign(models, {
    // A sink the prover reads itself is read as before: anything else is the library's.
    "effect/Stream:run": (args: ReadonlyArray<V>, site: Site): Eval<V> => {
      const read = base["effect/Stream:run"];
      const given = args.find(isSink);
      return !given || flows.read(given) ? read!(args, site) : run(args, site);
    },
    "effect/Stream:transduce": flows.lift("Stream.transduce", (to, self, [into]) =>
      Stream.transduce(self, built(to, into)),
    ),
    "effect/Stream:aggregate": flows.lift("Stream.aggregate", (to, self, [into]) =>
      Stream.aggregate(self, built(to, into)),
    ),
    // The sink ends, and gives what it has, when the schedule says so too.
    "effect/Stream:aggregateWithin": flows.lift(
      "Stream.aggregateWithin",
      (to, self, [into, given]) => {
        const held = tools.scheduleOf(given);
        return held
          ? Stream.aggregateWithin(self, built(to, into), held)
          : Stream.unwrap(Effect.as(to.wrong<never>(), Stream.empty));
      },
    ),
    // What the sink leaves over, as a stream.
    "effect/Stream:pipeThrough": flows.lift("Stream.pipeThrough", (to, self, [into]) =>
      Stream.pipeThrough(self, built(to, into)),
    ),
    "effect/Stream:tapSink": flows.lift("Stream.tapSink", (to, self, [into]) =>
      Stream.tapSink(self, built(to, into)),
    ),
    "effect/Stream:peel": flows.scoped_("Stream.peel", (to, self, [into]) =>
      Effect.map(Stream.peel(self, built(to, into)), ([value, rest]): V =>
        arr([value, flows.flow(to.timeline, rest, to.site, (item) => item)]),
      ),
    ),
  });

  // The sinks that are values: where they are used is where they are reported.
  const constant = (key: string, name: string, build: (to: Handing) => RealSink): V =>
    sink(name, build, undefined, constants[key]);
  const values: Record<string, V> = {
    "effect/Sink:count": constant("effect/Sink:count", "Sink.count", () =>
      Sink.map(Sink.count, Value.num),
    ),
    "effect/Sink:sum": constant("effect/Sink:sum", "Sink.sum", (to) =>
      folding<V>({
        first: false,
        initial: Effect.succeed(Value.num(0)),
        goesOn: always,
        step: (state, item) => to.read(host.arithmetic("+", state, item, to.site)),
        out: (state) => state,
      }),
    ),
    // A sink that takes every item and never ends: what runs into it waits, and is reported.
    "effect/Sink:never": sink(
      "Sink.never",
      (to) =>
        Sink.fromEffect(
          to.read(
            Timeline.waiting(
              to.timeline,
              "runs a stream into Sink.never, which never ends",
              to.site,
              Effect.never,
            ),
          ),
        ),
      undefined,
    ),
    "effect/Sink:drain": constant("effect/Sink:drain", "Sink.drain", () =>
      Sink.as(Sink.drain, Value.undef),
    ),
  };

  return { models: models as Models, values, isSink: (v: V): boolean => builders.has(v) };
};
