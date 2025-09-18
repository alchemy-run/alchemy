import type * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import type { PhysicalPlan } from "./plan.ts";

export const apply = <P extends PhysicalPlan, Err, Req>(
  plan: Effect.Effect<P, Err, Req>,
): Effect.Effect<
  {
    [id in keyof P]: Simplify<P[id]["attributes"]>;
    // [id in keyof P]: P[id]["attributes"];
  },
  Err,
  Req
> => {
  return provider.create({
    id: "1",
    news: {
      name: "test",
    },
  });
};
