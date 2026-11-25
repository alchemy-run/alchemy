import * as Cause from "effect/Cause";
import * as Channel from "effect/Channel";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type * as PubSub from "effect/PubSub";
import type * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, dualBy, native, onEffect, tagOf, wrongArguments } from "../Kit.ts";
import * as Timeline from "../Timeline.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";
import type * as Flows from "./Flows.ts";

type Held = Value.Rejected;
/** A channel the library runs: what it gives and what it ends with are values of the code. */
type Real = Channel.Channel<V, unknown, V>;
/** A channel is made of functions of the code, so it is made for the handler that runs it. */
type Made = (timeline: Timeline.Timeline) => Real;
type Flow = V & { readonly _tag: "Stream" };

/** What `Fibers` and `Flows` give to hand the code's values to the library and read its own back. */
export interface Tools extends Omit<Flows.Tools, "heldOf"> {
  readonly wrap: (kind: "Channel" | "Queue" | "PubSub" | "Scope", held: unknown) => V;
  readonly heldOf: <A>(
    kind: "Channel" | "Queue" | "PubSub" | "Subscription",
    v: V | undefined,
  ) => A | undefined;
  readonly exitOf: (timeline: Timeline.Timeline, exit: Exit.Exit<unknown, unknown>) => Eval<V>;
  readonly outputOf: (output: unknown) => V;
  readonly sure: <A>(self: Effect.Effect<A, Held>) => Effect.Effect<A>;
  readonly real: (timeline: Timeline.Timeline, self: Flow) => Stream.Stream<V, Held>;
  /** What a layer or a context the code gives provides, built now. */
  readonly provides: (
    name: string,
    given: V | undefined,
    site: Site,
  ) => Eval<ReadonlyArray<readonly [service: unknown, value: V]>>;
  /** Every service provided now, as a context of the code. */
  readonly context: () => V;
  readonly flow: <A>(
    timeline: Timeline.Timeline,
    made: Stream.Stream<A, unknown>,
    site: Site,
    give: (value: A) => V,
  ) => Flow;
}

/** The most values one run of a channel takes before the prover stops reading it. */
const MAX_VALUES = 10_000;

const WAIT = "waits for a channel that gives nothing more and does not end";

const done = Timeline.done;
const isDone = (v: V | undefined): v is V & { readonly _tag: "Obj" } =>
  v?._tag === "Obj" && tagOf(v) === "Done" && v.fields[Timeline.DONE] !== undefined;
const rejected = (rejection: V, defect = false): Eval<never> =>
  Effect.fail(new Value.Rejected(defect ? { rejection, defect } : { rejection }));

/**
 * `Channel`, `Pull` and `Take`: what a stream is made of. A channel is not
 * rewritten here. One the code writes is the library's own channel, made of
 * the code's functions and run on the handler's timeline, so what it gives,
 * what it ends with and when are what the deployed one does. A pull is an
 * effect that fails with `Cause.Done` when there is no more, and is read as
 * any effect is.
 */
export const make = (kit: Kit, tools: Tools) => {
  const { host } = kit;

  const channel = (made: Made): V => tools.wrap("Channel", made);
  const madeOf = (v: V | undefined): Made | undefined => tools.heldOf<Made>("Channel", v);
  const isChannel = (v: V | undefined): boolean => madeOf(v) !== undefined;
  const isFlow = (v: V | undefined): v is Flow => v?._tag === "Stream";

  /** A channel of the library's, with what it gives and ends with as values of the code. */
  const ours = <A, D>(made: Channel.Channel<A, unknown, D>): Real =>
    made.pipe(Channel.map(tools.outputOf), Channel.mapDone(tools.outputOf));

  /** An error a channel failed with, as the code sees it. */
  const seen = (error: unknown): V =>
    tagOf(error as V) === undefined &&
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "Rejected"
      ? (error as Held).rejection
      : Timeline.errorOf(error);

  const failing = (rejection: V): Real => Channel.fail(new Value.Rejected({ rejection }));

  /** A pull of the code, as the library takes one: no more is the library's own `Done`. */
  const pulled = (
    timeline: Timeline.Timeline,
    pull: V | undefined,
    site: Site,
    name: string,
  ): Effect.Effect<V, Held | Cause.Done<V>> =>
    pull?._tag === "Effect"
      ? Effect.catchIf(
          Timeline.real(timeline, pull.run),
          (failed) => failed.defect !== true && isDone(failed.rejection),
          (failed) =>
            Cause.done(
              isDone(failed.rejection)
                ? (failed.rejection.fields.value ?? Value.undef)
                : Value.undef,
            ),
        )
      : Timeline.real(timeline, wrongArguments(site, name));

  /** A pull of a stream: it ends with nothing. */
  const ending = <A>(
    self: Effect.Effect<A, Held | Cause.Done<V>>,
  ): Effect.Effect<A, Held | Cause.Done> => Effect.catchIf(self, Cause.isDone, () => Cause.done());

  /** What the models of one function hand the library, for the handler that runs the channel. */
  const given = (timeline: Timeline.Timeline, name: string, site: Site) => {
    const wrong = <A>(): Effect.Effect<A, Held> =>
      Timeline.real(timeline, wrongArguments(site, name));
    const bad: Real = wrong<never>().pipe(Channel.fromEffectDrain, ours);
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
    const chan = (v: V | undefined): Real => madeOf(v)?.(timeline) ?? bad;
    const inner =
      (f: V | undefined) =>
      (...args: ReadonlyArray<V>): Real =>
        Channel.unwrap(Effect.map(fn(f)(...args), chan));
    const eff = (v: V | undefined): Effect.Effect<V, Held> =>
      tools.effectOf(timeline, v, site) ?? wrong();
    const read = <A>(self: Eval<A>): Effect.Effect<A, Held> => Timeline.real(timeline, self);
    /** A cause the library gives, as the code holds one. */
    const cause = (failed: Cause.Cause<unknown>): Effect.Effect<V, Held> =>
      Effect.map(read(tools.exitOf(timeline, Exit.failCause(failed))), (exit) =>
        exit._tag === "Obj" ? (exit.fields.cause ?? Value.undef) : Value.undef,
      );
    const exit = (ended: Exit.Exit<unknown, unknown>): Effect.Effect<V, Held> =>
      read(tools.exitOf(timeline, ended));
    const plain = <A>(options: V | undefined, use: (options: A) => Real): Real => {
      if (options === undefined || options._tag === "Undef") return use(undefined as A);
      const found = tools.plainOf(options);
      return found === undefined ? bad : use(found as A);
    };
    return { timeline, name, site, bad, fn, test, chan, inner, eff, read, cause, exit, plain };
  };
  type Given = ReturnType<typeof given>;

  /** A channel that is made when the handler runs it. */
  const made = (name: string, site: Site, body: (to: Given) => Real): V =>
    channel((timeline) => Channel.suspend(() => body(given(timeline, name, site))));

  /** A function that gives a channel of values the code has. */
  const from =
    (name: string, body: (to: Given, args: ReadonlyArray<V>) => Real): Model =>
    (args, site) =>
      Effect.succeed(made(name, site, (to) => body(to, args)));

  /** A function of a channel, with the channel first or given it by `pipe`. */
  const over = (
    name: string,
    body: (to: Given, self: Real, rest: ReadonlyArray<V>) => Real,
  ): Model =>
    dualBy(name, isChannel, ([self, ...rest], site) =>
      isChannel(self)
        ? Effect.succeed(made(name, site, (to) => body(to, to.chan(self), rest)))
        : wrongArguments(site, name),
    );

  /** A function of two channels: it is given both only when its second argument is a channel. */
  const pairing =
    (
      name: string,
      body: (to: Given, self: Real, that: Real, rest: ReadonlyArray<V>) => Real,
    ): Model =>
    (args, site) => {
      const [first, second, ...rest] = args;
      const both = (self: V, that: V, more: ReadonlyArray<V>, at: Site): V =>
        made(name, at, (to) => body(to, to.chan(self), to.chan(that), more));
      if (first && second && isChannel(first) && isChannel(second))
        return Effect.succeed(both(first, second, rest, site));
      if (!first || !isChannel(first)) return wrongArguments(site, name);
      return Effect.succeed(
        native(name, ([self], at) =>
          self && isChannel(self)
            ? Effect.succeed(both(self, first, args.slice(1), at))
            : wrongArguments(at, name),
        ),
      );
    };

  /** A channel as it is run: one that may never end is not read. */
  const counted = (to: Given, self: Real): Real => {
    let values = 0;
    return Channel.mapEffect(self, (value) =>
      ++values > MAX_VALUES
        ? to.read(
            Effect.fail(
              Value.notTranslated(
                to.site,
                `runs a channel that has not ended after ${MAX_VALUES} values`,
              ),
            ),
          )
        : Effect.succeed(value),
    );
  };

  /** An effect of a channel: it is run on the handler's timeline. */
  const runs = (
    name: string,
    body: (to: Given, self: Real, rest: ReadonlyArray<V>) => Effect.Effect<V, unknown>,
  ): Model =>
    dualBy(name, isChannel, ([self, ...rest], site) =>
      isChannel(self)
        ? Effect.succeed<V>({
            _tag: "Effect",
            run: Effect.flatMap(Timeline.current(site, `runs ${name}`), (timeline) => {
              const to = given(timeline, name, site);
              return Timeline.back(
                timeline,
                Timeline.waiting(timeline, WAIT, site, body(to, counted(to, to.chan(self)), rest)),
                (value) => value,
              );
            }),
          })
        : wrongArguments(site, name),
    );

  /** An effect of a channel that leaves something open: it is run in the scope around it. */
  const opens = (
    name: string,
    body: (to: Given, self: Real, rest: ReadonlyArray<V>) => Effect.Effect<V, unknown, Scope.Scope>,
  ): Model =>
    dualBy(name, isChannel, ([self, ...rest], site) =>
      isChannel(self)
        ? Effect.succeed<V>({
            _tag: "Effect",
            run: Effect.gen(function* () {
              const timeline = yield* Timeline.current(site, `calls ${name}`);
              const scope = yield* Effect.serviceOption(Scope.Scope);
              if (Option.isNone(scope))
                return yield* Value.notTranslated(site, `calls ${name} outside Effect.scoped`);
              const to = given(timeline, name, site);
              return yield* Timeline.back(
                timeline,
                Effect.provideService(body(to, to.chan(self), rest), Scope.Scope, scope.value),
                (value) => value,
              );
            }),
          })
        : wrongArguments(site, name),
    );

  /** A pull the library made, as an effect of the code. */
  const pull = (timeline: Timeline.Timeline, site: Site, self: Effect.Effect<V, unknown>): V => ({
    _tag: "Effect",
    run: Timeline.back(timeline, Timeline.waiting(timeline, WAIT, site, self), (value) => value),
  });

  const option = (found: Option.Option<V>): V =>
    Option.isSome(found) ? Value.some(found.value) : Value.none;

  /** The items of a list the code gives, never none: the library's chunks have at least one. */
  const filled = (to: Given, self: Real): Channel.Channel<readonly [V, ...Array<V>], unknown, V> =>
    self.pipe(
      Channel.mapEffect((chunk) => to.read(tools.items(to.name, chunk, to.site))),
      Channel.filter((items): items is readonly [V, ...Array<V>] => items.length > 0),
    );

  /** A `Take` of the code, as the library takes one. */
  const take = (
    to: Given,
    v: V,
  ): Effect.Effect<readonly [V, ...Array<V>] | Exit.Exit<V, Held>, Held> => {
    const tag = tagOf(v);
    if (v._tag === "Obj" && tag === "Success")
      return Effect.succeed(Exit.succeed(v.fields.value ?? Value.undef));
    if (v._tag === "Obj" && tag === "Failure")
      return Effect.exit(to.read(failed(v.fields.cause))).pipe(
        Effect.map((ended) => ended as Exit.Exit<V, Held>),
      );
    return Effect.flatMap(to.read(tools.items(to.name, v, to.site)), (items) =>
      items.length > 0
        ? Effect.succeed(items as readonly [V, ...Array<V>])
        : to.read(wrongArguments(to.site, to.name)),
    );
  };

  // ---- A cause, as the code holds one.

  const reasonsOf = (cause: V | undefined): ReadonlyArray<V> =>
    (cause?._tag === "Obj" ? kit.itemsOf(cause.fields.reasons) : undefined) ?? [];
  const errorOfReason = (reason: V): V | undefined =>
    reason._tag === "Obj" && tagOf(reason) === "Fail" ? reason.fields.error : undefined;
  /** The `Done` a cause holds, when it holds one. */
  const doneOf = (cause: V | undefined): V | undefined =>
    reasonsOf(cause).map(errorOfReason).find(isDone);
  /** Whether a cause holds a failure or a defect that is not a `Done`. */
  const fails = (cause: V | undefined): boolean =>
    reasonsOf(cause).some(
      (reason) => tagOf(reason) !== "Interrupt" && !isDone(errorOfReason(reason)),
    );
  const without = (cause: V): V =>
    Value.obj({
      reasons: arr(reasonsOf(cause).filter((reason) => !isDone(errorOfReason(reason)))),
    });
  const causeOf = (reason: V): V => Value.obj({ reasons: arr([reason]) });
  const failureOf = (cause: V): V => Value.obj({ _tag: Value.str("Failure"), cause });
  /** An effect that ends as a cause says. */
  const failed = (cause: V | undefined): Eval<never> => {
    const reasons = reasonsOf(cause);
    const die = reasons.find((reason) => tagOf(reason) === "Die");
    const fail = reasons.find((reason) => tagOf(reason) === "Fail");
    if (die?._tag === "Obj") return rejected(die.fields.defect ?? Value.undef, true);
    if (fail?._tag === "Obj") return rejected(fail.fields.error ?? Value.undef);
    return Effect.interrupt;
  };
  /** `Pull.filterDone`: the `Done` of a cause, or the cause when it holds anything else. */
  const filterDone = (cause: V): V => {
    const found = doneOf(cause);
    return found && !fails(cause) ? Brands.success(found) : Brands.failure(without(cause));
  };
  /** The cause an effect failed with. */
  const caught = (self: Eval<V>, handle: (cause: V) => Eval<V>): Eval<V> =>
    Effect.catchTag(self, "Rejected", (stop) =>
      // What stops a saga until a signal comes is not an end of the effect.
      stop.rejection._tag === "Opaque"
        ? Effect.fail(stop)
        : handle(
            causeOf(
              stop.defect === true
                ? Value.obj({ _tag: Value.str("Die"), defect: stop.rejection })
                : Value.obj({ _tag: Value.str("Fail"), error: stop.rejection }),
            ),
          ),
    );
  const handler = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  const pulls: Models = {
    "effect/Cause:Done": ([value]) => Effect.succeed(done(value ?? Value.undef)),
    "effect/Cause:done": ([value]) =>
      Effect.succeed<V>({ _tag: "Effect", run: rejected(done(value ?? Value.undef)) }),
    "effect/Cause:isDone": ([value]) => Effect.succeed(Value.bool(isDone(value))),
    "effect/Pull:catchDone": onEffect("Pull.catchDone", 1, (self, [f], site) =>
      Effect.catchTag(self, "Rejected", (stop) =>
        stop.defect !== true && isDone(stop.rejection) && f
          ? kit.ran(f, [stop.rejection.fields.value ?? Value.undef], site)
          : Effect.fail(stop),
      ),
    ),
    "effect/Pull:isDoneCause": ([cause]) => Effect.succeed(Value.bool(doneOf(cause) !== undefined)),
    "effect/Pull:isDoneFailure": ([reason]) =>
      Effect.succeed(Value.bool(reason !== undefined && isDone(errorOfReason(reason)))),
    "effect/Pull:filterDone": ([cause], site) =>
      cause ? Effect.succeed(filterDone(cause)) : wrongArguments(site, "Pull.filterDone"),
    "effect/Pull:filterDoneVoid": ([cause], site) =>
      cause ? Effect.succeed(filterDone(cause)) : wrongArguments(site, "Pull.filterDoneVoid"),
    "effect/Pull:filterNoDone": ([cause], site) =>
      cause
        ? Effect.succeed(
            doneOf(cause) === undefined ? Brands.success(cause) : Brands.failure(cause),
          )
        : wrongArguments(site, "Pull.filterNoDone"),
    "effect/Pull:filterDoneLeftover": ([cause], site) => {
      if (!cause) return wrongArguments(site, "Pull.filterDoneLeftover");
      const found = doneOf(cause);
      return Effect.succeed(
        found?._tag === "Obj" && !fails(cause)
          ? Brands.success(found.fields.value ?? Value.undef)
          : Brands.failure(without(cause)),
      );
    },
    "effect/Pull:doneExitFromCause": ([cause], site) => {
      if (!cause) return wrongArguments(site, "Pull.doneExitFromCause");
      const found = doneOf(cause);
      return Effect.succeed(
        found?._tag === "Obj" && !fails(cause)
          ? Value.obj({ _tag: Value.str("Success"), value: found.fields.value ?? Value.undef })
          : failureOf(without(cause)),
      );
    },
    "effect/Pull:matchEffect": onEffect("Pull.matchEffect", 1, (self, [cases], site) => {
      const onSuccess = handler(cases, "onSuccess");
      const onFailure = handler(cases, "onFailure");
      const onDone = handler(cases, "onDone");
      if (!onSuccess || !onFailure || !onDone) return wrongArguments(site, "Pull.matchEffect");
      // The handlers are not inside what they handle: a failure of one is the effect's.
      return Effect.flatMap(
        caught(
          Effect.map(self, (value): V => Value.obj({ value })),
          (cause) => {
            const found = doneOf(cause);
            return Effect.succeed(
              found?._tag === "Obj" && !fails(cause)
                ? Value.obj({ done: found.fields.value ?? Value.undef })
                : Value.obj({ cause: without(cause) }),
            );
          },
        ),
        (ended) => {
          const fields = ended._tag === "Obj" ? ended.fields : {};
          if (fields.done) return kit.ran(onDone, [fields.done], site);
          if (fields.cause) return kit.ran(onFailure, [fields.cause], site);
          return kit.ran(onSuccess, [fields.value ?? Value.undef], site);
        },
      );
    }),
    "effect/Take:toPull": ([given_], site) => {
      const tag = tagOf(given_);
      if (given_?._tag === "Obj" && tag === "Success")
        return Effect.succeed<V>({
          _tag: "Effect",
          run: rejected(done(given_.fields.value ?? Value.undef)),
        });
      if (given_?._tag === "Obj" && tag === "Failure")
        return Effect.succeed<V>({ _tag: "Effect", run: failed(given_.fields.cause) });
      return Effect.map(tools.items("Take.toPull", given_, site), (items): V => ({
        _tag: "Effect",
        run: Effect.succeed(arr(items)),
      }));
    },
  };

  const lists: Models = {
    "effect/Channel:isChannel": ([value]) => Effect.succeed(Value.bool(isChannel(value))),
    "effect/Channel:succeed": from("Channel.succeed", (_, [value]) =>
      ours(Channel.succeed(value ?? Value.undef)),
    ),
    "effect/Channel:end": from("Channel.end", (_, [value]) => Channel.end(value ?? Value.undef)),
    "effect/Channel:sync": from("Channel.sync", (to, [f]) =>
      Effect.suspend(() => to.fn(f)()).pipe(Channel.fromEffect, ours),
    ),
    "effect/Channel:endSync": from("Channel.endSync", (to, [f]) =>
      Effect.suspend(() => to.fn(f)()).pipe(Channel.fromEffectDone, ours),
    ),
    "effect/Channel:fail": from("Channel.fail", (_, [error]) => failing(error ?? Value.undef)),
    "effect/Channel:failSync": from("Channel.failSync", (to, [f]) =>
      Channel.unwrap(Effect.map(to.fn(f)(), failing)),
    ),
    "effect/Channel:failCause": from("Channel.failCause", (to, [cause]) =>
      to.read(failed(cause)).pipe(Channel.fromEffectDrain, ours),
    ),
    "effect/Channel:failCauseSync": from("Channel.failCauseSync", (to, [f]) =>
      to
        .fn(f)()
        .pipe(
          Effect.flatMap((cause) => to.read(failed(cause))),
          Channel.fromEffectDrain,
          ours,
        ),
    ),
    "effect/Channel:die": from("Channel.die", (_, [defect]) =>
      Channel.die(new Timeline.Defect(defect ?? Value.undef)),
    ),
    "effect/Channel:fromEffect": from("Channel.fromEffect", (to, [effect]) =>
      to.eff(effect).pipe(Channel.fromEffect, ours),
    ),
    "effect/Channel:fromEffectDrain": from("Channel.fromEffectDrain", (to, [effect]) =>
      to.eff(effect).pipe(Channel.fromEffectDrain, ours),
    ),
    "effect/Channel:fromEffectDone": from("Channel.fromEffectDone", (to, [effect]) =>
      to.eff(effect).pipe(Channel.fromEffectDone, ours),
    ),
    "effect/Channel:fromEffectTake": from("Channel.fromEffectTake", (to, [effect]) =>
      Channel.fromEffectTake(Effect.flatMap(to.eff(effect), (given_) => take(to, given_))).pipe(
        Channel.map((items): V => arr(items)),
      ),
    ),
    "effect/Channel:fromPull": from("Channel.fromPull", (to, [effect]) =>
      to.eff(effect).pipe(
        Effect.map((made_) => pulled(to.timeline, made_, to.site, to.name)),
        Channel.fromPull,
        ours,
      ),
    ),
    "effect/Channel:suspend": from("Channel.suspend", (to, [f]) => to.inner(f)()),
    // A channel written as what it makes of the pull of its input.
    "effect/Channel:fromTransform": from("Channel.fromTransform", (to, [transform]) =>
      ours(
        Channel.fromTransform((upstream, scope: Scope.Scope) =>
          Effect.map(
            to.fn(transform)(
              pull(to.timeline, to.site, upstream as Effect.Effect<V, unknown>),
              tools.wrap("Scope", scope),
            ),
            (made_) => pulled(to.timeline, made_, to.site, to.name),
          ),
        ),
      ),
    ),
    "effect/Channel:unwrap": from("Channel.unwrap", (to, [effect]) =>
      Channel.unwrap(Effect.map(to.eff(effect), to.chan)),
    ),
    "effect/Channel:fromQueue": from("Channel.fromQueue", (to, [queue]) => {
      const held = tools.heldOf<Queue.Queue<V, Held | Cause.Done>>("Queue", queue);
      return held ? ours(Channel.fromQueue(held)) : to.bad;
    }),
    "effect/Channel:fromPubSub": from("Channel.fromPubSub", (to, [pubsub]) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      return held ? held.pipe(Channel.fromPubSub, ours) : to.bad;
    }),
    "effect/Channel:fromQueueArray": from("Channel.fromQueueArray", (to, [queue]) => {
      const held = tools.heldOf<Queue.Queue<V, Held | Cause.Done>>("Queue", queue);
      return held ? ours(Channel.fromQueueArray(held)) : to.bad;
    }),
    "effect/Channel:fromPubSubArray": from("Channel.fromPubSubArray", (to, [pubsub]) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      return held ? held.pipe(Channel.fromPubSubArray, ours) : to.bad;
    }),
    "effect/Channel:fromSubscription": from("Channel.fromSubscription", (to, [subscription]) => {
      const held = tools.heldOf<PubSub.Subscription<V>>("Subscription", subscription);
      return held ? held.pipe(Channel.fromSubscription, ours) : to.bad;
    }),
    "effect/Channel:fromSubscriptionArray": from(
      "Channel.fromSubscriptionArray",
      (to, [subscription]) => {
        const held = tools.heldOf<PubSub.Subscription<V>>("Subscription", subscription);
        return held ? held.pipe(Channel.fromSubscriptionArray, ours) : to.bad;
      },
    ),
    "effect/Channel:callback": from("Channel.callback", (to, [f, options]) =>
      to.plain<{ readonly bufferSize?: number }>(options, (read) =>
        ours(Channel.callback<V, Held>((queue) => to.fn(f)(tools.wrap("Queue", queue)), read)),
      ),
    ),
    "effect/Channel:fromSchedule": from("Channel.fromSchedule", (to, [schedule]) => {
      const held = tools.scheduleOf(schedule);
      return held ? held.pipe(Channel.fromSchedule, ours) : to.bad;
    }),
    "effect/Channel:acquireRelease": (args, site) => {
      const name = "Channel.acquireRelease";
      const build = (acquire: V | undefined, release: V | undefined, at: Site): V =>
        made(name, at, (to) =>
          ours(
            Channel.acquireRelease(to.eff(acquire), (value, ended) =>
              tools.sure(Effect.flatMap(to.exit(ended), (exit) => to.fn(release)(value, exit))),
            ),
          ),
        );
      return args[0]?._tag === "Effect"
        ? Effect.succeed(build(args[0], args[1], site))
        : Effect.succeed(
            native(name, ([self], at) =>
              self?._tag === "Effect"
                ? Effect.succeed(build(self, args[0], at))
                : wrongArguments(at, name),
            ),
          );
    },
  };

  /** A list the code gives, read once when the channel is written. */
  const listed =
    (name: string, build: (items: ReadonlyArray<V>, rest: ReadonlyArray<V>) => Real): Model =>
    ([given_, ...rest], site) =>
      Effect.map(tools.items(name, given_, site), (items) =>
        made(name, site, () => build(items, rest)),
      );
  Object.assign(lists, {
    "effect/Channel:fromIterable": listed("Channel.fromIterable", (items) =>
      ours(Channel.fromIterable(items)),
    ),
    "effect/Channel:fromChunk": listed("Channel.fromChunk", (items) =>
      ours(Channel.fromArray(items)),
    ),
    "effect/Channel:fromArray": listed("Channel.fromArray", (items) =>
      ours(Channel.fromArray(items)),
    ),
    "effect/Channel:fromIterableArray": listed("Channel.fromIterableArray", (items, [size]) =>
      ours(
        Channel.fromIterableArray(items, size?._tag === "Num" ? size.value : undefined).pipe(
          Channel.map((chunk): V => arr(chunk)),
        ),
      ),
    ),
  });

  const changes: Models = {
    "effect/Channel:map": over("Channel.map", (to, self, [f]) =>
      Channel.mapEffect(self, (item) => to.fn(f)(item)),
    ),
    "effect/Channel:mapEffect": over("Channel.mapEffect", (to, self, [f, options]) =>
      to.plain<{ readonly concurrency?: number | "unbounded"; readonly unordered?: boolean }>(
        options,
        (read) => Channel.mapEffect(self, (item, index) => to.fn(f)(item, Value.num(index)), read),
      ),
    ),
    "effect/Channel:mapDone": over("Channel.mapDone", (to, self, [f]) =>
      Channel.mapDoneEffect(self, (ended) => to.fn(f)(ended)),
    ),
    "effect/Channel:mapDoneEffect": over("Channel.mapDoneEffect", (to, self, [f]) =>
      Channel.mapDoneEffect(self, (ended) => to.fn(f)(ended)),
    ),
    "effect/Channel:tap": over("Channel.tap", (to, self, [f, options]) =>
      to.plain<{ readonly concurrency?: number | "unbounded" }>(options, (read) =>
        Channel.tap(self, (item) => to.fn(f)(item), read),
      ),
    ),
    "effect/Channel:flatMap": over("Channel.flatMap", (to, self, [f, options]) =>
      to.plain<{ readonly concurrency?: number | "unbounded"; readonly bufferSize?: number }>(
        options,
        (read) => Channel.flatMap(self, (item) => to.inner(f)(item), read),
      ),
    ),
    "effect/Channel:switchMap": over("Channel.switchMap", (to, self, [f, options]) =>
      to.plain<{ readonly concurrency?: number | "unbounded"; readonly bufferSize?: number }>(
        options,
        (read) => Channel.switchMap(self, (item) => to.inner(f)(item), read),
      ),
    ),
    "effect/Channel:mergeAll": over("Channel.mergeAll", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.bad
        : Channel.mergeAll(
            Channel.map(self, to.chan),
            read as { readonly concurrency: number | "unbounded" },
          );
    }),
    "effect/Channel:flatten": over("Channel.flatten", (to, self) =>
      Channel.flatten(Channel.map(self, to.chan)),
    ),
    "effect/Channel:flattenArray": over("Channel.flattenArray", (to, self) =>
      Channel.flattenArray(
        Channel.mapEffect(self, (chunk) => to.read(tools.items(to.name, chunk, to.site))),
      ),
    ),
    "effect/Channel:flattenTake": over("Channel.flattenTake", (to, self) =>
      Channel.flattenTake(Channel.mapEffect(self, (given_) => take(to, given_))).pipe(
        Channel.map((items): V => arr(items)),
      ),
    ),
    "effect/Channel:concatWith": over("Channel.concatWith", (to, self, [f]) =>
      Channel.concatWith(self, (ended) => to.inner(f)(ended)),
    ),
    "effect/Channel:concat": pairing("Channel.concat", (_, self, that) =>
      Channel.concat(self, that),
    ),
    "effect/Channel:merge": pairing("Channel.merge", (to, self, that, [options]) =>
      to.plain<{ readonly haltStrategy?: "left" | "right" | "both" | "either" }>(options, (read) =>
        Channel.merge(self, that, read),
      ),
    ),
    "effect/Channel:pipeTo": pairing("Channel.pipeTo", (_, self, that) =>
      Channel.pipeTo(self, that as unknown as Channel.Channel<V, unknown, V, V, unknown, V>),
    ),
    "effect/Channel:pipeToOrFail": pairing("Channel.pipeToOrFail", (_, self, that) =>
      Channel.pipeToOrFail(self, that as unknown as Channel.Channel<V, unknown, V, V, never, V>),
    ),
    "effect/Channel:mapInput": over(
      "Channel.mapInput",
      (to, self, [f]) =>
        Channel.mapInput(self as Channel.Channel<V, unknown, V, V>, (item: V) =>
          to.fn(f)(item),
        ) as unknown as Real,
    ),
    "effect/Channel:mapInputError": over("Channel.mapInputError", (to, self, [f]) =>
      Channel.catch(self, (error) => Channel.unwrap(Effect.map(to.fn(f)(seen(error)), failing))),
    ),
    "effect/Channel:mergeEffect": over("Channel.mergeEffect", (to, self, [effect]) =>
      Channel.mergeEffect(self, to.eff(effect)),
    ),
    // A field each record gives is given, made of the record by a function of the code.
    "effect/Channel:let": over("Channel.let", (to, self, [name, f]) =>
      name?._tag === "Str"
        ? Channel.mapEffect(self, (item) =>
            Effect.flatMap(
              to.read(f ? host.call(f, [item], to.site) : wrongArguments(to.site, to.name)),
              (made_): Effect.Effect<V, Held> =>
                item._tag === "Obj" && !item.brand
                  ? Effect.succeed(Value.obj({ ...item.fields, [name.value]: made_ }))
                  : to.read(wrongArguments(to.site, to.name)),
            ),
          )
        : to.bad,
    ),
    "effect/Channel:bindTo": over("Channel.bindTo", (to, self, [name]) =>
      name?._tag === "Str"
        ? Channel.map(self, (item): V => Value.obj({ [name.value]: item }))
        : to.bad,
    ),
    "effect/Channel:bind": over("Channel.bind", (to, self, [name, f, options]) =>
      name?._tag === "Str"
        ? to.plain<{ readonly concurrency?: number | "unbounded"; readonly bufferSize?: number }>(
            options,
            (read) =>
              Channel.flatMap(
                self,
                (item) =>
                  Channel.map(to.inner(f)(item), (made_): V =>
                    Value.obj({
                      ...(item._tag === "Obj" ? item.fields : {}),
                      [name.value]: made_,
                    }),
                  ),
                read,
              ),
          )
        : to.bad,
    ),
    "effect/Channel:filterArray": over("Channel.filterArray", (to, self, [f]) =>
      Channel.filterArrayEffect(filled(to, self), (item) => to.test(f)(item)).pipe(
        Channel.map((items): V => arr(items)),
      ),
    ),
    "effect/Channel:filterArrayEffect": over("Channel.filterArrayEffect", (to, self, [f]) =>
      Channel.filterArrayEffect(filled(to, self), (item) => to.test(f)(item)).pipe(
        Channel.map((items): V => arr(items)),
      ),
    ),
    "effect/Channel:bufferArray": over("Channel.bufferArray", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.bad
        : Channel.bufferArray(filled(to, self), read as { readonly capacity: "unbounded" }).pipe(
            Channel.map((items): V => arr(items)),
          );
    }),
    "effect/Channel:catchDefect": over("Channel.catchDefect", (to, self, [f]) =>
      Channel.catchDefect(self, (defect) =>
        // What stopped the prover is not a defect of the code.
        typeof defect === "object" &&
        defect !== null &&
        "_tag" in defect &&
        defect._tag === "Defect" &&
        "defect" in defect
          ? to.inner(f)(defect.defect as V)
          : Channel.die(defect),
      ),
    ),
    "effect/Channel:tapCause": over("Channel.tapCause", (to, self, [f]) =>
      ours(
        Channel.tapCause(self, (cause) =>
          Effect.flatMap(to.cause(cause), (held) => to.fn(f)(held)),
        ),
      ),
    ),
    "effect/Channel:catchCauseIf": over("Channel.catchCauseIf", (to, self, [test, f]) =>
      Channel.catchCause(self, (cause) =>
        Channel.unwrap(
          Effect.flatMap(to.cause(cause), (held) =>
            Effect.flatMap(to.test(test)(held), (holds) =>
              holds
                ? Effect.map(to.fn(f)(held), to.chan)
                : cause.pipe(Channel.failCause, Effect.succeed),
            ),
          ),
        ),
      ),
    ),
    "effect/Channel:ignoreCause": over("Channel.ignoreCause", (to, self) =>
      ours(
        Channel.catchCause(self, (cause) =>
          // What stopped the prover is not a failure of the code to pass over.
          Channel.unwrap(Effect.as(to.cause(cause), Channel.empty)),
        ),
      ),
    ),
    "effect/Channel:orElseIfEmpty": over("Channel.orElseIfEmpty", (to, self, [f]) =>
      Channel.orElseIfEmpty(self, (ended) => to.inner(f)(ended)),
    ),
    "effect/Channel:drain": over("Channel.drain", (_, self) => Channel.drain(self)),
    "effect/Channel:forever": over("Channel.forever", (_, self) => Channel.forever(self)),
    "effect/Channel:scoped": over("Channel.scoped", (_, self) => Channel.scoped(self)),
    "effect/Channel:repeat": over("Channel.repeat", (to, self, [schedule]) => {
      const held = tools.scheduleOf(schedule);
      return held ? Channel.repeat(self, held) : to.bad;
    }),
    "effect/Channel:retry": over("Channel.retry", (to, self, [schedule]) => {
      const held = tools.scheduleOf(schedule);
      return held ? Channel.retry(self, held) : to.bad;
    }),
    "effect/Channel:schedule": over("Channel.schedule", (to, self, [schedule]) => {
      const held = tools.scheduleOf(schedule);
      return held ? ours(Channel.schedule(self, held)) : to.bad;
    }),
    "effect/Channel:filter": over("Channel.filter", (to, self, [f]) =>
      Channel.filterEffect(self, (item) => to.test(f)(item)),
    ),
    "effect/Channel:filterEffect": over("Channel.filterEffect", (to, self, [f]) =>
      Channel.filterEffect(self, (item) => to.test(f)(item)),
    ),
    "effect/Channel:scan": over("Channel.scan", (to, self, [initial, f]) =>
      Channel.scanEffect(self, initial ?? Value.undef, (state, item) => to.fn(f)(state, item)),
    ),
    "effect/Channel:scanEffect": over("Channel.scanEffect", (to, self, [initial, f]) =>
      Channel.scanEffect(self, initial ?? Value.undef, (state, item) => to.fn(f)(state, item)),
    ),
    "effect/Channel:mapAccum": over("Channel.mapAccum", (to, self, [initial, f, options]) => {
      if (options !== undefined && options._tag !== "Undef") return to.bad;
      // The first state is what a function of the code gives, so it is asked for with the first item.
      return Channel.mapAccum(
        self,
        (): V | undefined => undefined,
        (state: V | undefined, item) =>
          Effect.gen(function* () {
            const before = state ?? (yield* to.fn(initial)());
            const pair = yield* to.fn(f)(before, item);
            const [next, out] = yield* to.read(tools.items(to.name, pair, to.site));
            const values = yield* to.read(tools.items(to.name, out, to.site));
            return [next ?? Value.undef, values] as const;
          }),
      );
    }),
    "effect/Channel:buffer": over("Channel.buffer", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.bad
        : Channel.buffer(self, read as { readonly capacity: "unbounded" });
    }),
    "effect/Channel:interruptWhen": over("Channel.interruptWhen", (to, self, [effect]) =>
      Channel.interruptWhen(self, to.eff(effect)),
    ),
    "effect/Channel:haltWhen": over("Channel.haltWhen", (to, self, [effect]) =>
      Channel.haltWhen(self, to.eff(effect)),
    ),
    "effect/Channel:onStart": over("Channel.onStart", (to, self, [effect]) =>
      Channel.onStart(self, to.eff(effect)),
    ),
    "effect/Channel:onFirst": over("Channel.onFirst", (to, self, [f]) =>
      Channel.onFirst(self, (item) => to.fn(f)(item)),
    ),
    "effect/Channel:onEnd": over("Channel.onEnd", (to, self, [effect]) =>
      Channel.onEnd(self, to.eff(effect)),
    ),
    "effect/Channel:ensuring": over("Channel.ensuring", (to, self, [effect]) =>
      Channel.ensuring(self, tools.sure(to.eff(effect))),
    ),
    "effect/Channel:onExit": over("Channel.onExit", (to, self, [f]) =>
      Channel.onExit(self, (ended) =>
        tools.sure(Effect.flatMap(to.exit(ended), (exit) => to.fn(f)(exit))),
      ),
    ),
    "effect/Channel:onError": over("Channel.onError", (to, self, [f]) =>
      Channel.onError(self, (cause) =>
        tools.sure(Effect.flatMap(to.cause(cause), (held) => to.fn(f)(held))),
      ),
    ),
    "effect/Channel:catch": over("Channel.catch", (to, self, [f]) =>
      Channel.catch(self, (error) => to.inner(f)(seen(error))),
    ),
    "effect/Channel:catchCause": over("Channel.catchCause", (to, self, [f]) =>
      Channel.catchCause(self, (cause) =>
        Channel.unwrap(
          Effect.flatMap(to.cause(cause), (held) => Effect.map(to.fn(f)(held), to.chan)),
        ),
      ),
    ),
    "effect/Channel:catchIf": over("Channel.catchIf", (to, self, [test, f]) =>
      Channel.catch(self, (error) =>
        Channel.unwrap(
          Effect.map(to.test(test)(seen(error)), (holds) =>
            holds ? to.inner(f)(seen(error)) : failing(seen(error)),
          ),
        ),
      ),
    ),
    "effect/Channel:catchTag": over("Channel.catchTag", (to, self, [tag, f]) => {
      const tags = tag?._tag === "Str" ? [tag.value] : (kit.itemsOf(tag) ?? []).map(tagText);
      if (tags.length === 0 || tags.includes(undefined)) return to.bad;
      return Channel.catch(self, (error) => {
        const found = tagOf(seen(error));
        return found !== undefined && tags.includes(found)
          ? to.inner(f)(seen(error))
          : failing(seen(error));
      });
    }),
    "effect/Channel:mapError": over("Channel.mapError", (to, self, [f]) =>
      Channel.catch(self, (error) => Channel.unwrap(Effect.map(to.fn(f)(seen(error)), failing))),
    ),
    "effect/Channel:tapError": over("Channel.tapError", (to, self, [f]) =>
      ours(Channel.tapError(self, (error) => to.fn(f)(seen(error)))),
    ),
    "effect/Channel:orDie": over("Channel.orDie", (_, self) =>
      Channel.catch(self, (error) => Channel.die(new Timeline.Defect(seen(error)))),
    ),
    "effect/Channel:ignore": over("Channel.ignore", (_, self) => self.pipe(Channel.ignore, ours)),
  };

  function tagText(v: V): string | undefined {
    return v._tag === "Str" ? v.value : undefined;
  }

  const ends: Models = {
    "effect/Channel:runCount": runs("Channel.runCount", (_, self) =>
      Effect.map(Channel.runCount(self), Value.num),
    ),
    "effect/Channel:runDrain": runs("Channel.runDrain", (_, self) => Channel.runDrain(self)),
    "effect/Channel:runCollect": runs("Channel.runCollect", (_, self) =>
      Effect.map(Channel.runCollect(self), arr),
    ),
    "effect/Channel:runHead": runs("Channel.runHead", (_, self) =>
      Effect.map(Channel.runHead(self), option),
    ),
    "effect/Channel:runLast": runs("Channel.runLast", (_, self) =>
      Effect.map(Channel.runLast(self), option),
    ),
    "effect/Channel:runForEach": runs("Channel.runForEach", (to, self, [f]) =>
      Effect.as(
        Channel.runForEach(self, (item) => to.fn(f)(item)),
        Value.undef,
      ),
    ),
    "effect/Channel:runForEachWhile": runs("Channel.runForEachWhile", (to, self, [f]) =>
      Effect.as(
        Channel.runForEachWhile(self, (item) => to.test(f)(item)),
        Value.undef,
      ),
    ),
    "effect/Channel:runFold": runs("Channel.runFold", (to, self, [initial, f]) =>
      Effect.flatMap(to.fn(initial)(), (first) =>
        Channel.runFoldEffect(
          self,
          () => first,
          (state, item) => to.fn(f)(state, item),
        ),
      ),
    ),
    "effect/Channel:runFoldEffect": runs("Channel.runFoldEffect", (to, self, [initial, f]) =>
      Effect.flatMap(to.fn(initial)(), (first) =>
        Channel.runFoldEffect(
          self,
          () => first,
          (state, item) => to.fn(f)(state, item),
        ),
      ),
    ),
    // ---- What the code makes of a pull: it is given one, and gives one back.
    // The channel comes first: the library has no form that is given it later.
    "effect/Channel:transformPull": ([given_, f]: ReadonlyArray<V>, site: Site) =>
      isChannel(given_)
        ? Effect.succeed(
            made("Channel.transformPull", site, (to) => {
              const self = to.chan(given_);
              return ours(
                Channel.transformPull(self, (upstream, scope) =>
                  Effect.map(
                    to.fn(f)(
                      pull(to.timeline, to.site, upstream as Effect.Effect<V, unknown>),
                      tools.wrap("Scope", scope),
                    ),
                    (made_) => pulled(to.timeline, made_, to.site, to.name),
                  ),
                ),
              );
            }),
          )
        : wrongArguments(site, "Channel.transformPull"),
    "effect/Channel:embedInput": over(
      "Channel.embedInput",
      (to, self, [input]) =>
        Channel.embedInput(self as Channel.Channel<V, unknown, V>, (upstream) =>
          Effect.asVoid(
            tools.sure(
              to.fn(input)(pull(to.timeline, to.site, upstream as Effect.Effect<V, unknown>)),
            ),
          ),
        ) as unknown as Real,
    ),
    "effect/Channel:toPull": opens("Channel.toPull", (to, self) =>
      Effect.map(Channel.toPull(self), (made_) => pull(to.timeline, to.site, made_)),
    ),
    "effect/Channel:runIntoQueue": runs("Channel.runIntoQueue", (to, self, [queue]) => {
      const held = tools.heldOf<Queue.Queue<V, unknown>>("Queue", queue);
      return held
        ? Effect.as(Channel.runIntoQueue(self, held), Value.undef)
        : to.read(wrongArguments(to.site, to.name));
    }),
    "effect/Channel:runIntoPubSub": runs("Channel.runIntoPubSub", (to, self, [pubsub, options]) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      const read = options === undefined || options._tag === "Undef" ? {} : tools.plainOf(options);
      return held && read !== undefined
        ? Effect.as(
            Channel.runIntoPubSub(self, held, read as { readonly shutdownOnEnd?: boolean }),
            Value.undef,
          )
        : to.read(wrongArguments(to.site, to.name));
    }),
    "effect/Channel:toPubSub": opens("Channel.toPubSub", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.read(wrongArguments(to.site, to.name))
        : Effect.map(Channel.toPubSub(self, read as { readonly capacity: "unbounded" }), (hub) =>
            tools.wrap("PubSub", hub),
          );
    }),
    // A channel of arrays, each item of each one into the queue or the PubSub.
    "effect/Channel:runIntoQueueArray": runs("Channel.runIntoQueueArray", (to, self, [queue]) => {
      const held = tools.heldOf<Queue.Queue<V, unknown>>("Queue", queue);
      return held
        ? Effect.as(Channel.runIntoQueueArray(filled(to, self), held), Value.undef)
        : to.read(wrongArguments(to.site, to.name));
    }),
    "effect/Channel:runIntoPubSubArray": runs(
      "Channel.runIntoPubSubArray",
      (to, self, [pubsub, options]) => {
        const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
        const read =
          options === undefined || options._tag === "Undef" ? {} : tools.plainOf(options);
        return held && read !== undefined
          ? Effect.as(
              Channel.runIntoPubSubArray(
                filled(to, self),
                held,
                read as { readonly shutdownOnEnd?: boolean },
              ),
              Value.undef,
            )
          : to.read(wrongArguments(to.site, to.name));
      },
    ),
    "effect/Channel:toPubSubArray": opens("Channel.toPubSubArray", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.read(wrongArguments(to.site, to.name))
        : Effect.map(
            Channel.toPubSubArray(filled(to, self), read as { readonly capacity: "unbounded" }),
            (hub) => tools.wrap("PubSub", hub),
          );
    }),
    "effect/Channel:toQueueArray": opens("Channel.toQueueArray", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.read(wrongArguments(to.site, to.name))
        : Effect.map(
            Channel.toQueueArray(filled(to, self), read as { readonly capacity: "unbounded" }),
            (queue) => tools.wrap("Queue", queue),
          );
    }),
    "effect/Channel:toQueue": opens("Channel.toQueue", (to, self, [options]) => {
      const read = tools.plainOf(options);
      return read === undefined || typeof read !== "object" || read === null
        ? to.read(wrongArguments(to.site, to.name))
        : Effect.map(Channel.toQueue(self, read as { readonly capacity: "unbounded" }), (queue) =>
            tools.wrap("Queue", queue),
          );
    }),
  };

  /** A stream and the channel it is made of. */
  const streams: Models = {
    "effect/Stream:fromChannel": ([given_], site) => {
      const made_ = madeOf(given_);
      return made_
        ? Effect.succeed<V>({
            _tag: "Stream",
            open: Effect.flatMap(Timeline.current(site, "runs Stream.fromChannel"), (timeline) => {
              const to = given(timeline, "Stream.fromChannel", site);
              return tools.flow(
                timeline,
                Stream.fromChannel(Channel.mapDone(filled(to, made_(timeline)), () => undefined)),
                site,
                (item) => item,
              ).open;
            }),
          })
        : wrongArguments(site, "Stream.fromChannel");
    },
    "effect/Stream:toChannel": ([given_], site) =>
      isFlow(given_)
        ? Effect.succeed(
            channel((timeline) =>
              tools.real(timeline, given_).pipe(
                Stream.toChannel,
                Channel.map((chunk): V => arr(chunk)),
                ours,
              ),
            ),
          )
        : wrongArguments(site, "Stream.toChannel"),
    "effect/Stream:callback": ([f, options], site) => {
      const read = options === undefined || options._tag === "Undef" ? {} : tools.plainOf(options);
      return read === undefined
        ? wrongArguments(site, "Stream.callback")
        : Effect.succeed<V>({
            _tag: "Stream",
            open: Effect.flatMap(Timeline.current(site, "runs Stream.callback"), (timeline) => {
              const to = given(timeline, "Stream.callback", site);
              return tools.flow(
                timeline,
                Stream.callback<V, Held>(
                  (queue) => to.fn(f)(tools.wrap("Queue", queue)),
                  read as { readonly bufferSize?: number },
                ),
                site,
                (item) => item,
              ).open;
            }),
          });
    },
    "effect/Stream:pipeThroughChannel": dualBy(
      "Stream.pipeThroughChannel",
      isFlow,
      ([self, through], site) => {
        const made_ = madeOf(through);
        return isFlow(self) && made_
          ? Effect.succeed<V>({
              _tag: "Stream",
              open: Effect.flatMap(
                Timeline.current(site, "runs Stream.pipeThroughChannel"),
                (timeline) => {
                  const to = given(timeline, "Stream.pipeThroughChannel", site);
                  // The channel is given each chunk of the stream as a list, and gives lists.
                  const lists_ = Channel.mapInput(
                    made_(timeline) as Channel.Channel<V, unknown, V, V>,
                    (chunk: readonly [V, ...Array<V>]) => Effect.succeed(arr(chunk)),
                  );
                  return tools.flow(
                    timeline,
                    Stream.pipeThroughChannel(
                      tools.real(timeline, self),
                      filled(to, lists_ as unknown as Real) as unknown as Channel.Channel<
                        readonly [V, ...Array<V>],
                        Held,
                        unknown,
                        readonly [V, ...Array<V>],
                        Held
                      >,
                    ),
                    site,
                    (item) => item,
                  ).open;
                },
              ),
            })
          : wrongArguments(site, "Stream.pipeThroughChannel");
      },
    ),
    "effect/Stream:fromPull": ([effect], site) =>
      Effect.succeed<V>({
        _tag: "Stream",
        open: Effect.flatMap(Timeline.current(site, "runs Stream.fromPull"), (timeline) => {
          const to = given(timeline, "Stream.fromPull", site);
          return tools.flow(
            timeline,
            Stream.fromPull(
              Effect.map(to.eff(effect), (made_) =>
                Effect.flatMap(ending(pulled(timeline, made_, site, to.name)), (chunk) =>
                  Effect.flatMap(to.read(tools.items(to.name, chunk, site)), (items) =>
                    items.length > 0
                      ? Effect.succeed(items as readonly [V, ...Array<V>])
                      : to.read(wrongArguments(site, to.name)),
                  ),
                ),
              ),
            ),
            site,
            (item) => item,
          ).open;
        }),
      }),
    "effect/Stream:toPull": ([given_], site) =>
      isFlow(given_)
        ? Effect.succeed<V>({
            _tag: "Effect",
            run: Effect.gen(function* () {
              const timeline = yield* Timeline.current(site, "calls Stream.toPull");
              const scope = yield* Effect.serviceOption(Scope.Scope);
              if (Option.isNone(scope))
                return yield* Value.notTranslated(
                  site,
                  "calls Stream.toPull outside Effect.scoped",
                );
              return yield* Timeline.back(
                timeline,
                Effect.provideService(
                  Stream.toPull(tools.real(timeline, given_)),
                  Scope.Scope,
                  scope.value,
                ),
                (pulling) =>
                  pull(
                    timeline,
                    site,
                    Effect.map(pulling, (chunk): V => arr(chunk)),
                  ),
              );
            }),
          })
        : wrongArguments(site, "Stream.toPull"),
  };

  const models: Record<string, Model> = { ...pulls, ...lists, ...changes, ...ends, ...streams };

  Object.assign(models, {
    "effect/Channel:identity": from("Channel.identity", () =>
      ours(Channel.identity<V, unknown, V>() as unknown as Channel.Channel<V, unknown, V>),
    ),
  });

  // ---- Filters and reasons, as a channel has them.

  /** A function of the code, called for what it gives: an effect it gives is a value, and is not run. */
  const straight =
    (to: Given, f: V | undefined) =>
    (...args: ReadonlyArray<V>): Effect.Effect<V, Held> =>
      to.read(f && callable(f) ? host.call(f, args, to.site) : wrongArguments(to.site, to.name));
  /** The `Result` a filter of the code gave, as the library's. */
  const sorted = (to: Given, made_: V): Effect.Effect<Result.Result<V, V>, Held> => {
    const read = Brands.resultOf(made_);
    if (!read) return to.read(wrongArguments(to.site, to.name));
    return Effect.succeed(
      read._tag === "Success" ? Result.succeed(read.success) : Result.fail(read.failure),
    );
  };
  const unset = (v: V | undefined): boolean => v === undefined || v._tag === "Undef";
  const reasonOf = (rejection: V, tag: V | undefined): V | undefined =>
    tag?._tag === "Str" && tagOf(rejection) === tag.value && rejection._tag === "Obj"
      ? rejection.fields.reason
      : undefined;
  const keptOfArrays = (to: Given, self: Real, filter: (item: V) => Effect.Effect<V, Held>): Real =>
    Channel.filterMapEffect(self, (chunk: V) =>
      Effect.gen(function* () {
        const kept: Array<V> = [];
        for (const item of yield* to.read(tools.items(to.name, chunk, to.site))) {
          const made_ = yield* sorted(to, yield* filter(item));
          if (Result.isSuccess(made_)) kept.push(made_.success);
        }
        return kept.length > 0 ? Result.succeed<V>(arr(kept)) : Result.fail(chunk);
      }),
    );
  /** A channel that goes on as another where its error holds a reason, and fails as it did where it does not. */
  const byReason = (
    name: string,
    next: (to: Given, reason: V, error: V, rest: ReadonlyArray<V>) => Real | undefined,
  ): Model =>
    over(name, (to, self, [errorTag, ...rest]) =>
      Channel.catch(self, (error): Real => {
        const rejection = seen(error);
        const reason = reasonOf(rejection, errorTag);
        return (reason && next(to, reason, rejection, rest)) ?? failing(rejection);
      }),
    );

  Object.assign(models, {
    // Each array the channel gives, with the items the filter passes on: an array of none is dropped.
    "effect/Channel:filterMapArray": over("Channel.filterMapArray", (to, self, [filter]) =>
      keptOfArrays(to, self, (item) => straight(to, filter)(item)),
    ),
    "effect/Channel:filterMapArrayEffect": over(
      "Channel.filterMapArrayEffect",
      (to, self, [filter]) => keptOfArrays(to, self, (item) => to.fn(filter)(item)),
    ),
    "effect/Channel:filterMap": over("Channel.filterMap", (to, self, [filter]) =>
      Channel.filterMapEffect(self, (item: V) =>
        Effect.flatMap(straight(to, filter)(item), (made_) => sorted(to, made_)),
      ),
    ),
    "effect/Channel:filterMapEffect": over("Channel.filterMapEffect", (to, self, [filter]) =>
      Channel.filterMapEffect(self, (item: V) =>
        Effect.flatMap(to.fn(filter)(item), (made_) => sorted(to, made_)),
      ),
    ),
    "effect/Channel:catchFilter": over("Channel.catchFilter", (to, self, [filter, f, orElse]) =>
      Channel.catch(self, (error) =>
        Channel.unwrap(
          Effect.map(
            Effect.flatMap(straight(to, filter)(seen(error)), (made_) => sorted(to, made_)),
            (made_): Real => {
              if (Result.isSuccess(made_)) return to.inner(f)(made_.success);
              return unset(orElse) ? failing(made_.failure) : to.inner(orElse)(made_.failure);
            },
          ),
        ),
      ),
    ),
    "effect/Channel:catchCauseFilter": over("Channel.catchCauseFilter", (to, self, [filter, f]) =>
      Channel.catchCause(self, (cause) =>
        Channel.unwrap(
          Effect.flatMap(to.cause(cause), (held) =>
            Effect.map(
              Effect.flatMap(straight(to, filter)(held), (made_) => sorted(to, made_)),
              (made_): Real =>
                Result.isSuccess(made_)
                  ? to.inner(f)(made_.success, held)
                  : Channel.failCause(tools.realCause(made_.failure) ?? cause),
            ),
          ),
        ),
      ),
    ),
    "effect/Channel:catchReason": byReason("Channel.catchReason", (to, reason, error, rest) => {
      const [reasonTag, f, orElse] = rest;
      if (reasonTag?._tag !== "Str") return to.bad;
      if (tagOf(reason) === reasonTag.value) return to.inner(f)(reason, error);
      return unset(orElse) ? undefined : to.inner(orElse)(reason, error);
    }),
    "effect/Channel:catchReasons": byReason("Channel.catchReasons", (to, reason, error, rest) => {
      const [cases, orElse] = rest;
      if (cases?._tag !== "Obj") return to.bad;
      const handler = cases.fields[tagOf(reason) ?? ""];
      if (!unset(handler)) return to.inner(handler)(reason, error);
      return unset(orElse) ? undefined : to.inner(orElse)(reason, error);
    }),
    "effect/Channel:unwrapReason": byReason("Channel.unwrapReason", (_, reason) => failing(reason)),
    // What is acquired is given to the channel, and released when the channel ends, however it ends.
    "effect/Channel:acquireUseRelease": from(
      "Channel.acquireUseRelease",
      (to, [acquire, use, release]) =>
        ours(
          Channel.acquireUseRelease(
            to.eff(acquire),
            (value: V) => to.inner(use)(value),
            (value, ended) =>
              tools.sure(Effect.flatMap(to.exit(ended), (exit) => to.fn(release)(value, exit))),
          ),
        ),
    ),
    // A span says how the channel is watched: it is the channel it was.
    "effect/Channel:withSpan": ([first]: ReadonlyArray<V>) =>
      Effect.succeed(
        isChannel(first)
          ? first!
          : native("Channel.withSpan", ([self]) => Effect.succeed(self ?? Value.undef)),
      ),
  });

  // ---- Channels pulled as a function of the code says, and the bracket forms of a transform.
  const asPull = (upstream: unknown): Effect.Effect<V, unknown> =>
    upstream as Effect.Effect<V, unknown>;
  /** An effect of the code that ends a pull: a failure with `Cause.Done` is the library's own, with its value. */
  const endingWith = <A>(self: Effect.Effect<A, Held>): Effect.Effect<A, Held | Cause.Done<V>> =>
    Effect.catchIf(
      self,
      (failed): boolean => failed.defect !== true && isDone(failed.rejection),
      (failed) =>
        Cause.done(
          isDone(failed.rejection) ? (failed.rejection.fields.value ?? Value.undef) : Value.undef,
        ),
    );
  Object.assign(models, {
    "effect/Channel:combine": (args: ReadonlyArray<V>, site: Site) => {
      const build = (
        self: V,
        that: V,
        initial: V | undefined,
        f: V | undefined,
        at: Site,
      ): Eval<V> =>
        isChannel(self) && isChannel(that) && initial && f
          ? Effect.succeed(
              made("Channel.combine", at, (to) =>
                Channel.unwrap(
                  Effect.map(
                    Effect.suspend(() => to.read(host.call(initial, [], at))),
                    (state) =>
                      ours(
                        Channel.combine(
                          to.chan(self),
                          to.chan(that),
                          () => state,
                          (s: V, pullLeft: unknown, pullRight: unknown) =>
                            endingWith(
                              Effect.flatMap(
                                to.fn(f)(
                                  s,
                                  pull(to.timeline, at, asPull(pullLeft)),
                                  pull(to.timeline, at, asPull(pullRight)),
                                ),
                                (pair) => stepOf(to, pair),
                              ),
                            ),
                        ) as never,
                      ),
                  ),
                ),
              ),
            )
          : wrongArguments(at, "Channel.combine");
      const [a, b, c, d] = args;
      if (args.length === 4 && a && b) return build(a, b, c, d, site);
      return a
        ? Effect.succeed(
            native("Channel.combine", ([self], at) =>
              self ? build(self, a, b, c, at) : wrongArguments(at, "Channel.combine"),
            ),
          )
        : wrongArguments(site, "Channel.combine");
    },
    "effect/Channel:fromTransformBracket": ([transform]: ReadonlyArray<V>, site: Site) =>
      transform
        ? Effect.succeed(
            made("Channel.fromTransformBracket", site, (to) =>
              ours(
                Channel.fromTransformBracket((upstream, scope, forked) =>
                  Effect.map(
                    to.fn(transform)(
                      pull(to.timeline, to.site, asPull(upstream)),
                      tools.wrap("Scope", scope),
                      tools.wrap("Scope", forked),
                    ),
                    (made_) => pulled(to.timeline, made_, to.site, to.name),
                  ),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Channel.fromTransformBracket"),
    // The stream comes first: the library has no form that is given it later.
    "effect/Stream:transformPullBracket": ([self, f]: ReadonlyArray<V>, site: Site) =>
      isFlow(self) && f
        ? Effect.succeed(
            streaming("Stream.transformPullBracket", site, (to) =>
              Stream.transformPullBracket(
                tools.real(to.timeline, self),
                (upstream, scope, forked) =>
                  Effect.map(
                    to.fn(f)(
                      pull(
                        to.timeline,
                        site,
                        Effect.map(upstream, (chunk): V => arr(chunk)),
                      ),
                      tools.wrap("Scope", scope),
                      tools.wrap("Scope", forked),
                    ),
                    (made_) =>
                      Effect.flatMap(
                        pulled(to.timeline, made_, site, to.name) as never,
                        (chunk: V) =>
                          Effect.flatMap(to.read(tools.items(to.name, chunk, site)), (items) =>
                            items.length > 0
                              ? Effect.succeed(items as readonly [V, ...Array<V>])
                              : to.read(wrongArguments(site, to.name)),
                          ),
                      ),
                  ),
              ),
            ),
          )
        : wrongArguments(site, "Stream.transformPullBracket"),
    // A pull of the channel, open as long as the scope the code gives.
    "effect/Channel:toPullScoped": ([self, scope]: ReadonlyArray<V>, site: Site) => {
      const held = tools.heldOf<Scope.Scope>("Scope" as never, scope);
      return isChannel(self) && held
        ? Effect.succeed<V>({
            _tag: "Effect",
            run: Effect.flatMap(Timeline.current(site, "runs Channel.toPullScoped"), (timeline) => {
              const to = given(timeline, "Channel.toPullScoped", site);
              return Timeline.back(timeline, Channel.toPullScoped(to.chan(self), held), (made_) =>
                pull(timeline, site, made_ as Effect.Effect<V, unknown>),
              );
            }),
          })
        : wrongArguments(site, "Channel.toPullScoped");
    },
    // Arrays of text cut into lines, of text the code can see.
    "effect/Channel:splitLines": from(
      "Channel.splitLines",
      (to) =>
        Channel.mapInput(
          Channel.map(Channel.splitLines<unknown, V>(), (lines): V => arr(lines.map(Value.str))),
          (chunk: V) =>
            Effect.flatMap(to.read(tools.items(to.name, chunk, to.site)), (items) => {
              const texts = items.map((item) => (item._tag === "Str" ? item.value : undefined));
              return texts.length > 0 && texts.every((text) => text !== undefined)
                ? Effect.succeed(texts as unknown as readonly [string, ...Array<string>])
                : to.read(
                    Value.notTranslated(
                      to.site,
                      "calls Channel.splitLines on text an input decides",
                    ),
                  );
            }),
        ) as unknown as Real,
    ),
  });

  // ---- Services provided to a channel: around its start and around each pull of it.
  type Provided = ReadonlyArray<readonly [service: unknown, value: V]>;
  const withServices =
    (held: Provided) =>
    <A, E>(self: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.suspend(() => {
        const before = held.map(([service]) => [service, host.provided.get(service)] as const);
        for (const [service, value] of held) host.provided.set(service, value);
        return Effect.ensuring(
          self,
          Effect.sync(() => {
            for (const [service, value] of before.toReversed())
              if (value) host.provided.set(service, value);
              else host.provided.delete(service);
          }),
        );
      });
  /** Only these services, around each pull of the channel. */
  const replacingChannel = (self: Real, held: Provided): Real =>
    Channel.transformPull(self, (upstream) =>
      Effect.succeed(
        Effect.suspend(() => {
          const before = [...host.provided.entries()];
          host.provided.clear();
          for (const [service, value] of held) host.provided.set(service, value);
          return Effect.ensuring(
            asPull(upstream),
            Effect.sync(() => {
              host.provided.clear();
              for (const [service, value] of before) host.provided.set(service, value);
            }),
          );
        }),
      ),
    ) as unknown as Real;
  const providing_ = (self: Real, held: Provided): Real =>
    Channel.transformPull(self, (upstream) =>
      Effect.succeed(upstream.pipe(asPull, withServices(held))),
    ) as unknown as Real;
  const serviceOf = (to: Given, tag: V | undefined): Effect.Effect<unknown, Held> =>
    tag?._tag === "Host" ? Effect.succeed(tag.value) : to.read(wrongArguments(to.site, to.name));
  Object.assign(models, {
    "effect/Channel:provideService": over("Channel.provideService", (to, self, [tag, value]) =>
      Channel.unwrap(
        Effect.map(serviceOf(to, tag), (service) =>
          providing_(self, [[service, value ?? Value.undef]]),
        ),
      ),
    ),
    "effect/Channel:provideServiceEffect": over(
      "Channel.provideServiceEffect",
      (to, self, [tag, effect]) =>
        Channel.unwrap(
          Effect.flatMap(serviceOf(to, tag), (service) =>
            Effect.map(to.eff(effect), (value) => providing_(self, [[service, value]])),
          ),
        ),
    ),
    "effect/Channel:provideContext": over("Channel.provideContext", (to, self, [given_]) =>
      Channel.unwrap(
        Effect.map(to.read(tools.provides("Channel.provideContext", given_, to.site)), (held) =>
          providing_(self, held),
        ),
      ),
    ),
    "effect/Channel:provide": over("Channel.provide", (to, self, [given_, options]) =>
      options === undefined || options._tag === "Undef"
        ? Channel.unwrap(
            Effect.map(to.read(tools.provides("Channel.provide", given_, to.site)), (held) =>
              providing_(self, held),
            ),
          )
        : to.bad,
    ),
    // The channel the function makes of the services provided where it starts.
    "effect/Channel:contextWith": from("Channel.contextWith", (to, [f]) =>
      Channel.unwrap(Effect.suspend(() => Effect.map(to.fn(f)(tools.context()), to.chan))),
    ),
    // The channel runs with the services the function makes of the ones provided, and no others.
    "effect/Channel:updateContext": over("Channel.updateContext", (to, self, [f]) =>
      Channel.unwrap(
        Effect.suspend(() =>
          Effect.map(
            Effect.flatMap(
              to.read(
                f ? host.call(f, [tools.context()], to.site) : wrongArguments(to.site, to.name),
              ),
              (made_) => to.read(tools.provides("Channel.updateContext", made_, to.site)),
            ),
            (held) => replacingChannel(self, held),
          ),
        ),
      ),
    ),
    // The service is what the function makes of it while the channel runs.
    "effect/Channel:updateService": over("Channel.updateService", (to, self, [tag, f]) =>
      Channel.unwrap(
        Effect.flatMap(serviceOf(to, tag), (service) => {
          const before = host.provided.get(service);
          if (!before)
            return to.read(
              Value.notTranslated(
                to.site,
                "calls Channel.updateService of a service that nothing provides",
              ),
            );
          return Effect.map(
            to.read(f ? host.call(f, [before], to.site) : wrongArguments(to.site, to.name)),
            (next) => providing_(self, [[service, next]]),
          );
        }),
      ),
    ),
  });

  // ---- A stream of what the code makes of the pull of another.
  Object.assign(models, {
    "effect/Stream:transformPull": (args: ReadonlyArray<V>, site: Site) => {
      const build = (self: V, f: V, at: Site): V =>
        streaming("Stream.transformPull", at, (to) =>
          Stream.transformPull(tools.real(to.timeline, self as never), (upstream, scope) =>
            Effect.map(
              to.fn(f)(
                pull(
                  to.timeline,
                  at,
                  Effect.map(upstream, (chunk): V => arr(chunk)),
                ),
                tools.wrap("Scope", scope),
              ),
              (made_) =>
                Effect.flatMap(pulled(to.timeline, made_, at, to.name) as never, (chunk: V) =>
                  Effect.flatMap(to.read(tools.items(to.name, chunk, at)), (items) =>
                    items.length > 0
                      ? Effect.succeed(items as readonly [V, ...Array<V>])
                      : to.read(wrongArguments(at, to.name)),
                  ),
                ),
            ),
          ),
        );
      // The stream comes first: the library has no form that is given it later.
      const [a, b] = args;
      return isFlow(a) && b
        ? Effect.succeed(build(a, b, site))
        : wrongArguments(site, "Stream.transformPull");
    },
    // The channel as a function of a pull of its input: it gives an effect of the pull it makes.
    "effect/Channel:toTransform": ([self]: ReadonlyArray<V>, site: Site) =>
      isChannel(self)
        ? Effect.succeed(
            native("Channel.toTransform", ([upstream, scope], at) => {
              const held = tools.heldOf<Scope.Scope>("Scope" as never, scope);
              return held && upstream
                ? Effect.succeed<V>({
                    _tag: "Effect",
                    run: Effect.flatMap(
                      Timeline.current(at, "runs Channel.toTransform"),
                      (timeline) => {
                        const to = given(timeline, "Channel.toTransform", at);
                        return Timeline.back(
                          timeline,
                          Channel.toTransform(to.chan(self))(
                            pulled(timeline, upstream, at, to.name) as never,
                            held,
                          ),
                          (made_) => pull(timeline, at, made_ as Effect.Effect<V, unknown>),
                        );
                      },
                    ),
                  })
                : wrongArguments(at, "Channel.toTransform");
            }),
          )
        : wrongArguments(site, "Channel.toTransform"),
  });

  // ---- Streams that pull two others as a function of the code says, and streams of `Take`s.

  /** A stream the library makes, for the handler that opens it. */
  const streaming = (
    name: string,
    site: Site,
    build: (to: Given) => Stream.Stream<V, unknown>,
  ): V => ({
    _tag: "Stream",
    open: Effect.flatMap(
      Timeline.current(site, `runs ${name}`),
      (timeline) =>
        tools.flow(timeline, build(given(timeline, name, site)), site, (item) => item).open,
    ),
  });
  /** An effect of the code that ends a pull: a failure with `Cause.Done` is the library's own. */
  const ending_ = <A>(self: Effect.Effect<A, Held>): Effect.Effect<A, Held | Cause.Done> =>
    Effect.catchIf(
      self,
      (failed) => failed.defect !== true && isDone(failed.rejection),
      () => Cause.done(),
    );
  /** The value and the state of the pair a function of the code gives. */
  const stepOf = (to: Given, pair: V): Effect.Effect<readonly [V, V], Held> =>
    Effect.map(to.read(tools.items(to.name, pair, to.site)), ([value, state]) => [
      value ?? Value.undef,
      state ?? Value.undef,
    ]);
  const combining =
    (name: string, arrays: boolean): Model =>
    (args, site) => {
      const build = (
        self: V,
        that: V,
        initial: V | undefined,
        f: V | undefined,
        at: Site,
      ): Eval<V> =>
        isFlow(self) && isFlow(that) && initial && f
          ? Effect.succeed(
              streaming(name, at, (to) => {
                const [left, right] = [
                  tools.real(to.timeline, self),
                  tools.real(to.timeline, that),
                ];
                const first = Effect.suspend(() => to.read(host.call(initial, [], at)));
                return arrays
                  ? Stream.unwrap(
                      Effect.map(first, (state) =>
                        Stream.combineArray(
                          left,
                          right,
                          () => state,
                          (s, pullLeft, pullRight) =>
                            ending_(
                              Effect.flatMap(
                                to.fn(f)(
                                  s,
                                  pull(
                                    to.timeline,
                                    at,
                                    Effect.map(pullLeft, (items): V => arr(items)),
                                  ),
                                  pull(
                                    to.timeline,
                                    at,
                                    Effect.map(pullRight, (items): V => arr(items)),
                                  ),
                                ),
                                (pair) =>
                                  Effect.flatMap(stepOf(to, pair), ([out, next]) =>
                                    Effect.flatMap(to.read(tools.items(name, out, at)), (items) =>
                                      items.length > 0
                                        ? Effect.succeed([
                                            items as readonly [V, ...Array<V>],
                                            next,
                                          ] as const)
                                        : to.read(wrongArguments(at, name)),
                                    ),
                                  ),
                              ),
                            ),
                        ),
                      ),
                    )
                  : Stream.unwrap(
                      Effect.map(first, (state) =>
                        Stream.combine(
                          left,
                          right,
                          () => state,
                          (s, pullLeft, pullRight) =>
                            ending_(
                              Effect.flatMap(
                                to.fn(f)(
                                  s,
                                  pull(to.timeline, at, pullLeft),
                                  pull(to.timeline, at, pullRight),
                                ),
                                (pair) => stepOf(to, pair),
                              ),
                            ),
                        ),
                      ),
                    );
              }),
            )
          : wrongArguments(at, name);
      const [a, b, c, d] = args;
      if (args.length === 4 && a && b) return build(a, b, c, d, site);
      return a
        ? Effect.succeed(
            native(name, ([self], at) =>
              self ? build(self, a, b, c, at) : wrongArguments(at, name),
            ),
          )
        : wrongArguments(site, name);
    };

  Object.assign(models, {
    "effect/Stream:combine": combining("Stream.combine", false),
    "effect/Stream:combineArray": combining("Stream.combineArray", true),
    // The function is given the chunks of each, and gives what to emit and what is left of each.
    "effect/Stream:zipWithArray": (args: ReadonlyArray<V>, site: Site) => {
      const build = (left: V, right: V, f: V | undefined, at: Site): Eval<V> =>
        isFlow(left) && isFlow(right) && f
          ? Effect.succeed(
              streaming("Stream.zipWithArray", at, (to) =>
                Stream.zipWithArray(
                  tools.real(to.timeline, left),
                  tools.real(to.timeline, right),
                  (l, r) => {
                    let made_: V | undefined;
                    try {
                      made_ = host.atOnce(f, [arr(l), arr(r)], at);
                    } catch {
                      made_ = undefined;
                    }
                    const [out, restL, restR] = (made_ && kit.itemsOf(made_)) ?? [];
                    const items = out ? kit.itemsOf(out) : undefined;
                    if (!items || items.length === 0) {
                      to.timeline.fatal ??= Value.notTranslated(
                        at,
                        "calls Stream.zipWithArray with a function the prover cannot run at once",
                      );
                      return [[...l] as unknown as readonly [V, ...Array<V>], [], []] as const;
                    }
                    return [
                      items as readonly [V, ...Array<V>],
                      (restL && kit.itemsOf(restL)) ?? [],
                      (restR && kit.itemsOf(restR)) ?? [],
                    ] as const;
                  },
                ),
              ),
            )
          : wrongArguments(at, "Stream.zipWithArray");
      const [a, b, c] = args;
      if (args.length === 3 && a && b) return build(a, b, c, site);
      return a
        ? Effect.succeed(
            native("Stream.zipWithArray", ([self], at) =>
              self ? build(self, a, b, at) : wrongArguments(at, "Stream.zipWithArray"),
            ),
          )
        : wrongArguments(site, "Stream.zipWithArray");
    },
    // A stream of the code's `Take`s, as the items they hold: an `Exit` ends it.
    "effect/Stream:flattenTake": ([self]: ReadonlyArray<V>, site: Site) =>
      isFlow(self)
        ? Effect.succeed(
            streaming(
              "Stream.flattenTake",
              site,
              (to) =>
                Stream.flattenTake(
                  Stream.mapEffect(tools.real(to.timeline, self), (item) =>
                    take(to, item),
                  ) as never,
                ) as Stream.Stream<V, unknown>,
            ),
          )
        : wrongArguments(site, "Stream.flattenTake"),
    "effect/Stream:fromPubSubTake": ([pubsub]: ReadonlyArray<V>, site: Site) => {
      const held = tools.heldOf<PubSub.PubSub<V>>("PubSub", pubsub);
      return held
        ? Effect.succeed(
            streaming(
              "Stream.fromPubSubTake",
              site,
              (to) =>
                Stream.flattenTake(
                  Stream.mapEffect(Stream.fromPubSub(held), (item) => take(to, item)) as never,
                ) as Stream.Stream<V, unknown>,
            ),
          )
        : wrongArguments(site, "Stream.fromPubSubTake");
    },
  });

  const sited: Readonly<Record<string, (site: Site) => V>> = {
    "effect/Channel:DefaultChunkSize": () => Value.num(Channel.DefaultChunkSize),
    "effect/Channel:empty": (site) => made("Channel.empty", site, () => ours(Channel.empty)),
    "effect/Channel:Do": (site) =>
      made("Channel.Do", site, () => Channel.succeed<V>(Value.obj({})).pipe(ours)),
    "effect/Channel:never": (site) => made("Channel.never", site, () => Channel.never),
  };

  return { models, sited };
};
