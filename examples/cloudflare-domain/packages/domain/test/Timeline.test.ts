import * as Timeline from "@alchemy.run/domain/Prove/internal/Timeline";
import type * as Value from "@alchemy.run/domain/Prove/internal/Value";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// A handler's timeline, run on its own: what happens to it when the run it is in is stopped.

const site = {} as Value.Site;
const noRun = (): Value.Run => {
  throw new Error("the run is not asked: the times here are numbers");
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
