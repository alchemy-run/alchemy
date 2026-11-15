import * as Explore from "@alchemy.run/domain/Explore";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Ladder, LadderApi } from "./fixtures/Ladder.model.ts";

// Every sequence of a few commands is run. A rule that takes more commands to
// break is out of their reach, so longer sequences are run too: walks of
// commands picked at random, from a seed.

const ladder = (walks: { readonly count: number; readonly seed?: number }) =>
  Explore.report(Ladder, {
    source: new URL("./fixtures/Ladder.model.ts", import.meta.url),
    apis: [LadderApi],
    walks,
  });

const climbs = (report: Explore.ModelReport) =>
  report.rules[0]?.broken?.map((step) => (step.command as { _tag: string })._tag);

it.effect(
  "a rule that takes five commands to break is found by a walk, and not by two commands",
  () =>
    Effect.gen(function* () {
      const short = yield* ladder({ count: 0 });
      expect(short.rules).toMatchObject([{ name: "NobodyReachesTheTop", broken: undefined }]);
      expect(short.rules[0]?.states).toBeGreaterThan(0);
      const walked = yield* ladder({ count: 40 });
      // Five climbs by one climber, with whatever else the walk sent on the way.
      expect(climbs(walked)?.filter((tag) => tag === "Climb").length).toBeGreaterThanOrEqual(5);
      expect(walked.walks).toMatchObject({ seed: 1, count: 40, longest: 12 });
      expect(walked.disagreements).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "the same seed walks the same way",
  () =>
    Effect.gen(function* () {
      const first = yield* ladder({ count: 40, seed: 7 });
      const again = yield* ladder({ count: 40, seed: 7 });
      expect(climbs(again)).toEqual(climbs(first));
      expect(again.sequences).toBe(first.sequences);
      expect(again.walks).toEqual(first.walks);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);

it.effect(
  "verifying a model walks it unless told not to",
  () =>
    Effect.gen(function* () {
      const failed = yield* Verify.model(Ladder, { apis: [LadderApi] }).pipe(Effect.flip);
      expect(failed._tag).toBe("NotVerified");
      expect(failed.message).toContain("Sampled: 200 longer sequences");
      expect(failed.message).toContain("✗ Ladder.NobodyReachesTheTop breaks");
      const passed = yield* Verify.model(Ladder, { apis: [LadderApi], walks: { count: 0 } });
      expect(passed.rules).toMatchObject([{ standing: "checked" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
