import { PassThrough } from "node:stream";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer as cliKitLayer } from "@/Cli/CliKit/index.ts";
import { renderPlanning } from "@/Cli/commands/render.ts";
import { TerminalCancelled } from "@/Interaction.ts";
import { Cli } from "@/Report.ts";

// Runs `effect` under `renderPlanning` and reports how the planning status
// row settled.
const settle = Effect.fn(function* <E>(effect: Effect.Effect<never, E>) {
  const settled: Array<string> = [];
  const cli = Cli.of({
    startPlanningSession: () =>
      Effect.succeed({
        update: () => Effect.void,
        succeed: () => Effect.sync(() => void settled.push("succeed")),
        fail: (message) => Effect.sync(() => void settled.push(`fail: ${message}`)),
        close: Effect.void,
      }),
    approvePlan: () => Effect.succeed(true),
    displayPlan: () => Effect.void,
    startApplySession: () => Effect.succeed({ done: () => Effect.void, emit: () => Effect.void }),
  });
  const stdout = new PassThrough();
  yield* effect.pipe(
    renderPlanning({ operation: "Deploy", stage: "test" }),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Cli, cli),
        cliKitLayer({
          input: false,
          // SAFETY: a PassThrough covers the writable surface Sigil uses.
          stdout: stdout as unknown as NodeJS.WriteStream,
          captureConsole: false,
        }),
      ),
    ),
    Effect.ignore,
    Effect.scoped,
  );
  return settled;
});

it.effect(
  "a prompt cancelled mid-plan is not reported as a planning failure",
  () =>
    Effect.gen(function* () {
      expect(yield* settle(Effect.fail(new TerminalCancelled()))).toEqual([]);
      expect(yield* settle(Effect.fail(new Error("boom")))).toEqual(["fail: Planning failed"]);
    }),
  { tags: ["unit", "local"] },
);
