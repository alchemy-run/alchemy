import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { refreshAndSave } from "@/Auth/Refresh.ts";

it.live(
  "an interrupt during the request still waits for the save",
  () =>
    Effect.gen(function* () {
      let saved: string | undefined;
      const fiber = yield* refreshAndSave(
        Effect.sleep("200 millis").pipe(Effect.as("rotated")),
        (fresh) =>
          Effect.sync(() => {
            saved = fresh;
          }),
      ).pipe(Effect.forkChild);

      yield* Effect.sleep("50 millis");
      yield* Fiber.interrupt(fiber);

      expect(saved).toBe("rotated");
    }),
  { tags: ["unit", "local"] },
);

it.live(
  "a failed request saves nothing",
  () =>
    Effect.gen(function* () {
      let saved = false;
      const exit = yield* refreshAndSave(Effect.fail("refused"), () =>
        Effect.sync(() => {
          saved = true;
        }),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(saved).toBe(false);
    }),
  { tags: ["unit", "local"] },
);
