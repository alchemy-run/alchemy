import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import { PRODUCTION_ACCOUNT, refuseProduction } from "./guard.ts";

it.effect(
  "refuses the production account",
  () =>
    Effect.gen(function* () {
      const error = yield* refuseProduction(PRODUCTION_ACCOUNT).pipe(Effect.flip);
      expect(error._tag).toBe("WrongAccount");
    }),
  { tags: ["unit", "provider:convex", "local"] },
);

it.effect(
  "refuses an unknown account",
  () =>
    Effect.gen(function* () {
      const error = yield* refuseProduction(undefined).pipe(Effect.flip);
      expect(error._tag).toBe("WrongAccount");
    }),
  { tags: ["unit", "provider:convex", "local"] },
);

it.effect("allows the dev account", () => refuseProduction("840448280878"), {
  tags: ["unit", "provider:convex", "local"],
});
