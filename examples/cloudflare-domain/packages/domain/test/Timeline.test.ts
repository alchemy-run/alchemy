import * as Timeline from "@alchemy.run/domain/Prove/internal/Timeline";
import * as Value from "@alchemy.run/domain/Prove/internal/Value";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

// A handler's timeline, run on its own: what it does where no table reaches it.

const site = {
  module: { path: "here.ts", lineStarts: [0] },
  node: { start: 0 },
} as unknown as Value.Site;
const noRun = (): Value.Run => {
  throw new Error("the run is not asked: the times here are numbers");
};
const reasonOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failed = exit.cause.reasons.find(Cause.isFailReason);
  const error = failed?.error as { readonly reason?: string } | undefined;
  return error?.reason;
};

it.live("a run stopped from outside stops the handler it began", () =>
  Effect.gen(function* () {
    let finalized = false;
    // The handler waits on work outside it, which the timeline holds open, until the run is stopped.
    const handler = Timeline.outside(Effect.never).pipe(
      Effect.ensuring(Effect.sync(() => void (finalized = true))),
    );
    const ran = yield* Timeline.run(noRun, site, handler).pipe(Effect.timeoutOption("20 millis"));
    expect(Option.isNone(ran)).toBe(true);
    expect(finalized).toBe(true);
  }),
);

it.effect(
  "a handler that waits for nothing that comes is reported, by what waits if anything does",
  () =>
    Effect.gen(function* () {
      const never = yield* Effect.exit(Timeline.run(noRun, site, Effect.never));
      expect(reasonOf(never)).toBe("waits for something that never comes");
      // The handler itself waits on nothing it names: a fiber it began does.
      const forked = Effect.gen(function* () {
        const timeline = yield* Effect.service(Timeline.Current);
        yield* Effect.forkChild(
          Timeline.waiting(timeline!, "waits for a signal", site, Effect.never),
        );
        return yield* Effect.never;
      });
      const waiting = yield* Effect.exit(Timeline.run(noRun, site, forked));
      expect(reasonOf(waiting)).toBe("waits for a signal: the handler would never end");
    }),
);

it.effect("a wait with no end comes after one the solver holds", () =>
  Effect.gen(function* () {
    // Neither time is a number the other can be compared with but one never ends.
    const raced = (times: ReadonlyArray<Timeline.Time>) =>
      Effect.gen(function* () {
        const timeline = yield* Effect.service(Timeline.Current);
        return yield* Effect.raceAll(
          times.map((time) => Effect.as(timeline!.instant.sleep(time), String(time))),
        );
      });
    // A time the solver holds is one the run takes a side on: here, that it is after now.
    const solving = () => new Value.Run([]);
    expect(yield* Timeline.run(solving, site, raced([Infinity, "held"]))).toBe("held");
    expect(yield* Timeline.run(solving, site, raced(["held", Infinity]))).toBe("held");
    // Two waits that never end are not two that end at once.
    expect(yield* Timeline.run(solving, site, raced([Infinity, Infinity, "held"]))).toBe("held");
  }),
);

it.effect("what reads the timeline outside a handler says so", () =>
  Effect.gen(function* () {
    const read = yield* Effect.exit(Timeline.current(site, "reads the clock"));
    expect(reasonOf(read)).toBe("reads the clock outside a handler");
  }),
);

it("the library's errors and stops are read as the prover holds them", () => {
  // An end with no value of the code's, and an error with no tag.
  expect(Timeline.errorOf({ _tag: "Done", [Timeline.DONE]: Timeline.DONE })).toEqual(
    Timeline.done(Value.undef),
  );
  expect(Timeline.errorOf(5)).toEqual({ _tag: "Opaque", what: "an error of the library" });
  // A stop of another timeline's is the stop, where this one has none of its own.
  const other = new Timeline.Timeline(noRun, (pump) => queueMicrotask(pump));
  const stop = Value.notTranslated(site, "stops elsewhere");
  const exit = Effect.runSyncExit(Timeline.real(other, Effect.fail(stop)));
  const here = new Timeline.Timeline(noRun, (pump) => queueMicrotask(pump));
  expect(Exit.isFailure(exit) && Timeline.stopOf(here, exit.cause)).toBe(stop);
});
