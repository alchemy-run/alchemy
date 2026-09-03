/**
 * The spill net's contract (sandbox/SpillingTools.ts): presentation stays
 * direct (each mention keeps its provider tool), oversized SUCCESS
 * strings are parked in the Artifacts behind a head preview + a
 * readOutput id, bounded results and failures pass through verbatim —
 * and the net injects its own `readOutput` wire tool so the ticket is
 * always redeemable.
 */
import * as AI from "alchemy/AI";
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SpillingTools } from "../src/sandbox/SpillingTools.ts";
import { Artifacts } from "../src/sandbox/Artifacts.ts";
import { ArtifactsLocal } from "../src/sandbox/ArtifactsLocal.ts";
import { ReadOutputLive } from "../src/sandbox/ReadOutput.ts";

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
      const artifacts = yield* Artifacts;

      const fat = "x".repeat(100) + "\n";
      const presented = yield* engine.present([
        mention("bounded", "small result"),
        mention("unbounded", fat.repeat(1000)), // ~101 KB
      ]);

      // presentation stays DIRECT: one provider tool per mention,
      // plus the net's own redemption door
      expect(presented.tools.map((tool) => tool.name)).toEqual([
        "bounded",
        "unbounded",
        "readOutput",
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
      const retained = yield* artifacts.read(id!);
      expect(retained.length).toBe(101_000);

      // the ticket is redeemable through the net's OWN readOutput —
      // no charter mention required
      const paged = (yield* presented.handlers.readOutput!({
        outputId: id!,
        offset: 1,
        limit: 5,
      })) as string;
      expect(paged).toContain("x".repeat(100));
      expect(paged).toContain("Use offset=6 to continue.");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SpillingTools, Layer.empty).pipe(
          Layer.provide(ReadOutputLive),
          Layer.provideMerge(ArtifactsLocal),
        ),
      ),
      Effect.provide(BunServices.layer),
      Effect.scoped,
    ) as Effect.Effect<void>,
  );
});
