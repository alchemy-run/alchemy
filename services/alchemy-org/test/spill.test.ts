/**
 * The spill net's contract (lib/Spill.ts): presentation stays direct
 * (each mention keeps its provider tool), oversized SUCCESS strings
 * are parked in the ToolOutputStore behind a head preview + readOutput
 * id, bounded results and failures pass through verbatim.
 */
import * as AI from "alchemy/AI";
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SpillTools } from "../src/lib/Spill.ts";
import {
  ToolOutputStore,
  ToolOutputStoreLive,
} from "../src/lib/ToolOutputStore.ts";

const mention = (
  name: string,
  result: string,
): AI.ToolMention => ({
  name,
  description: "test tool",
  parameters: {},
  returns: {},
  errors: [],
  tool: { name } as never,
  handler: () => Effect.succeed(result),
});

test("oversized output spills to an artifact; bounded output passes through", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* AI.Tools;
      const store = yield* ToolOutputStore;

      const fat = "x".repeat(100) + "\n";
      const presented = yield* engine.present([
        mention("bounded", "small result"),
        mention("unbounded", fat.repeat(1000)), // ~101 KB
      ]);

      // presentation stays DIRECT: one provider tool per mention
      expect(presented.tools.map((tool) => tool.name)).toEqual([
        "bounded",
        "unbounded",
      ]);

      // under the cap: verbatim
      const small = yield* presented.handlers.bounded!({});
      expect(small).toBe("small result");

      // over the cap: preview + opaque id, full text in the store
      const big = (yield* presented.handlers.unbounded!({})) as string;
      expect(big.length).toBeLessThan(70_000);
      expect(big).toContain("[Output truncated:");
      const id = big.match(/Full output: (output-\d+-\w+)/)?.[1];
      expect(id).toBeDefined();
      const retained = yield* store.read(id!);
      expect(retained.length).toBe(101_000);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SpillTools, Layer.empty).pipe(
          Layer.provideMerge(ToolOutputStoreLive),
        ),
      ),
      Effect.provide(BunServices.layer),
      Effect.scoped,
    ) as Effect.Effect<void>,
  );
});
