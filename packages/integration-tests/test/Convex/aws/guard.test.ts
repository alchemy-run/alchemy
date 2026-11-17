import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { refuseProduction } from "./guard.ts";

const PRODUCTION = Option.some("111111111111");
const tags = { tags: ["unit", "provider:convex", "local"] };

it.effect(
  "refuses the production account",
  () =>
    Effect.gen(function* () {
      const error = yield* refuseProduction("111111111111", PRODUCTION).pipe(Effect.flip);
      expect(error._tag).toBe("WrongAccount");
    }),
  tags,
);

it.effect(
  "refuses an unknown account",
  () =>
    Effect.gen(function* () {
      const error = yield* refuseProduction(undefined, Option.none()).pipe(Effect.flip);
      expect(error._tag).toBe("WrongAccount");
    }),
  tags,
);

it.effect("allows any other account", () => refuseProduction("222222222222", PRODUCTION), tags);

it.effect(
  "allows any account when none is named",
  () => refuseProduction("222222222222", Option.none()),
  tags,
);
