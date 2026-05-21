import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export const ALCHEMY_PHASE = Config.string("ALCHEMY_PHASE").pipe(
  Config.withDefault("plan"),
  Effect.orDie,
);
