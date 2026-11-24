import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import { Instant, type Timekeeping } from "../../internal.ts";
import type { Eval, Run, Site, Stop, V } from "./Value.ts";
import * as Value from "./Value.ts";

/**
 * A handler's time and its fibers. The prover reads a handler as the library
 * runs one: its effects are run by the library itself, on time that passes
 * only when no fiber can run. A sleep, a time limit, a race and a fiber then
 * do what the deployed ones do, in the order their durations give, and a
 * wait for something that never comes is found and reported.
 */

/** A moment or a span: milliseconds the code writes, or the solver's text for ones an input decides. */
export type Time = number | string;

/** What a fiber waits for, to say of a handler that never ends. */
interface Wait {
  readonly what: string;
  readonly site: Site;
}

export class Timeline {
  readonly instant: Instant<Time>;
  /** What stopped the prover in some fiber: the path is not read, whatever the others did. */
  fatal: Stop | undefined;
  /** What each fiber that waits is waiting for, by its id. */
  readonly waits = new Map<number, Wait>();
  /** How many times effects were run again: one that never stops is not read. */
  turns = 0;

  constructor(run: () => Run, defer: (pump: () => void) => void) {
    const text = (time: Time): string => (typeof time === "number" ? String(time) : time);
    const keeping: Timekeeping<Time> = {
      zero: 0,
      of: (millis) => millis,
      add: (time, span) =>
        typeof time === "number" && typeof span === "number"
          ? time + span
          : `(+ ${text(time)} ${text(span)})`,
      order: (a, b) => {
        if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
        // A wait with no end comes after every other.
        if (a === Infinity) return 1;
        if (b === Infinity) return -1;
        if (run().branch(`(< ${text(a)} ${text(b)})`)) return -1;
        return run().branch(`(< ${text(b)} ${text(a)})`) ? 1 : 0;
      },
      positive: (span) => (typeof span === "number" ? span > 0 : run().branch(`(> ${span} 0)`)),
    };
    this.instant = new Instant(keeping, defer);
  }
}

/** The timeline of the handler being read: none outside one. */
export const Current = Context.Reference<Timeline | undefined>("alchemy/Domain/Prove/Timeline", {
  defaultValue: () => undefined,
});

/** The timeline of the handler being read, for code that is only read inside one. */
export const current = (site: Site, what: string): Eval<Timeline> =>
  Effect.flatMap(Effect.service(Current), (timeline) =>
    timeline
      ? Effect.succeed(timeline)
      : Effect.fail(Value.notTranslated(site, `${what} outside a handler`)),
  );

/** A defect, as a real one while the library runs the effect it is in. */
export class Defect {
  readonly _tag = "Defect";
  readonly defect: V;
  constructor(defect: V) {
    this.defect = defect;
  }
}

/** What stopped the prover, as a real defect: the library does not handle it, and the path is not read. */
class Fatal {
  readonly _tag = "Fatal";
  readonly stop: Stop;
  constructor(stop: Stop) {
    this.stop = stop;
  }
}

/**
 * An effect of the code, as one the library runs: a failure the code can
 * handle is a failure, a defect is a defect, and what stops the prover is
 * kept, so that no race and no fiber loses it.
 */
export const real = (timeline: Timeline, self: Eval<V>): Effect.Effect<V, Value.Rejected> =>
  Effect.catch(self, (stop) => {
    if (stop._tag === "Rejected")
      return stop.defect === true ? Effect.die(new Defect(stop.rejection)) : Effect.fail(stop);
    timeline.fatal ??= stop;
    return Effect.die(new Fatal(stop));
  });

const tagOf = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "_tag" in value ? value._tag : undefined;

/** An error the library itself fails with, as a value: a `TimeoutError`, a queue's `Done`. */
const errorOf = (error: unknown): V => {
  const tag = tagOf(error);
  return typeof tag === "string"
    ? Value.obj({ _tag: Value.str(tag) })
    : { _tag: "Opaque", what: "an error of the library" };
};

/** Why an effect the library ran did not give a value, as the prover holds it. */
export const stopOf = (timeline: Timeline, cause: Cause.Cause<unknown>): Stop | undefined => {
  if (timeline.fatal) return timeline.fatal;
  for (const reason of cause.reasons)
    if (Cause.isDieReason(reason) && tagOf(reason.defect) === "Fatal")
      return (reason.defect as Fatal).stop;
  for (const reason of cause.reasons)
    if (Cause.isFailReason(reason)) {
      const error = reason.error;
      const tag = tagOf(error);
      if (tag === "Rejected" || tag === "NotTranslated" || tag === "Infeasible")
        return error as Stop;
      return new Value.Rejected({ rejection: errorOf(error) });
    }
  for (const reason of cause.reasons)
    if (Cause.isDieReason(reason))
      return new Value.Rejected({
        rejection:
          tagOf(reason.defect) === "Defect"
            ? (reason.defect as Defect).defect
            : { _tag: "Opaque", what: `a defect of the library: ${String(reason.defect)}` },
        defect: true,
      });
  return undefined;
};

/** What the library gave, as an effect of the code. An interrupt goes on as one. */
export const back = <A>(
  timeline: Timeline,
  self: Effect.Effect<A, unknown>,
  give: (value: A) => V,
): Eval<V> =>
  Effect.matchCauseEffect(self, {
    onSuccess: (value) => Effect.succeed(give(value)),
    onFailure: (cause): Eval<V> => {
      const stop = stopOf(timeline, cause);
      return stop ? Effect.fail(stop) : Effect.failCause(cause as Cause.Cause<never>);
    },
  });

/** Say what a fiber waits for while it does: a handler that never ends is reported with it. */
export const waiting = <A, E>(
  timeline: Timeline,
  what: string,
  site: Site,
  self: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.withFiber((fiber) => {
    // A wait inside another is the one the fiber is in, until it is over.
    const before = timeline.waits.get(fiber.id);
    timeline.waits.set(fiber.id, { what, site });
    return Effect.ensuring(
      self,
      Effect.sync(() => {
        if (before) timeline.waits.set(fiber.id, before);
        else timeline.waits.delete(fiber.id);
      }),
    );
  });

/**
 * Work done outside the handler, such as reading a file it imports. Time
 * stands still and no other fiber runs until it is done, so the order the
 * fibers run in does not depend on how long it took.
 */
export const outside = <A, E>(self: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.flatMap(Effect.service(Current), (timeline) => {
    if (!timeline) return self;
    return Effect.suspend(() => {
      timeline.instant.busy++;
      return Effect.ensuring(
        self,
        Effect.sync(() => {
          timeline.instant.busy--;
        }),
      );
    });
  });

/** The clock the library reads while it runs a handler: its time stands still, and a sleep is the timeline's. */
const clockOf = (timeline: Timeline): Clock.Clock => ({
  currentTimeMillisUnsafe: () => 0,
  currentTimeMillis: Effect.succeed(0),
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.succeed(0n),
  monotonicTimeNanosUnsafe: () => 0n,
  monotonicTimeNanos: Effect.succeed(0n),
  sleep: (duration) => timeline.instant.sleep(Duration.toMillis(duration)),
});

/**
 * Read a handler on a timeline of its own. It ends when its own fiber does.
 * A handler that waits for something no fiber of it ever does would never
 * end, and is reported with what it waits for.
 */
export const run = <A>(current: () => Run, site: Site, self: Eval<A>): Eval<A> =>
  Effect.callback<A, Stop>((resume) => {
    const timeline = new Timeline(current, (pump) => queueMicrotask(pump));
    let settled = false;
    const settle = (exit: Exit.Exit<A, Stop> | Eval<never>) => {
      if (settled) return;
      settled = true;
      resume(
        timeline.fatal
          ? Effect.fail(timeline.fatal)
          : timeline.instant.tied
            ? Effect.fail(
                Value.notTranslated(
                  site,
                  "two waits end at the same moment, and which the deployed handler ends first is not known",
                ),
              )
            : exit,
      );
    };
    const fiber = Effect.runFork(
      self.pipe(
        Effect.provideService(Current, timeline),
        Effect.provideService(Clock.Clock, clockOf(timeline)),
      ),
      { scheduler: timeline.instant.scheduler },
    );
    fiber.addObserver((exit) =>
      // A handler stopped by an interrupt of its own records nothing, and is not read further.
      settle(
        exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.fail(Value.notTranslated(site, "the handler interrupts itself"))
          : exit,
      ),
    );
    timeline.instant.onIdle = () => {
      if (settled || timeline.instant.busy > 0) return;
      const wait = timeline.waits.get(fiber.id) ?? [...timeline.waits.values()][0];
      const never = wait
        ? Value.notTranslated(wait.site, `${wait.what}: the handler would never end`)
        : Value.notTranslated(site, "waits for something that never comes");
      settle(never.pipe(Effect.fail));
    };
    timeline.instant.pump();
    return Effect.sync(() => {
      settled = true;
      fiber.interruptUnsafe();
    });
  });
