import * as Explore from "@alchemy.run/domain/Explore";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Chores, ChoresApi, Lingering, LingeringApi } from "./fixtures/Chore.model.ts";

// An invariant says what is never true along the way. `eventually` says where
// every sequence ends up, once nothing is left to react or come due.

const source = new URL("./fixtures/Chore.model.ts", import.meta.url);

it.effect(
  "a rule that is false along the way holds in the end, past the commands a caller sends",
  () =>
    Effect.gen(function* () {
      // One command from a caller: the two schedules after it are run to the end.
      const report = yield* Explore.check(Chores, { source, apis: [ChoresApi], depth: 1 });
      expect(report.eventually).toMatchObject([{ name: "EveryChoreIsDropped", broken: undefined }]);
      expect(report.eventually[0]?.states).toBeGreaterThan(0);
      const dropped = report.outcomes.find((outcome) => outcome.tag === "ChoreDropped")?.story;
      expect(dropped?.map((step) => [step.after, (step.command as { _tag: string })._tag])).toEqual(
        [
          [undefined, "Start"],
          ["1 hour", "Nudge"],
          ["1 day", "Drop"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a sequence that ends without it is found, and the check fails",
  () =>
    Effect.gen(function* () {
      const failed = yield* Explore.check(Lingering, {
        source,
        apis: [LingeringApi],
        depth: 1,
      }).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantBroken");
      if (failed._tag !== "InvariantBroken" || !("model" in failed.report)) return;
      const story = failed.report.eventually[0]?.broken;
      expect(story?.map((step) => (step.command as { _tag: string })._tag)).toEqual([
        "Start",
        "Nudge",
      ]);
      expect(failed.message).toContain("✗ Lingering.EveryChoreIsDropped does not hold in the end");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
