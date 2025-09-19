import * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import type { PhysicalPlan } from "./plan.ts";

export const apply = <P extends PhysicalPlan, Err, Req>(
  plan: Effect.Effect<P, Err, Req>,
) =>
  plan.pipe(
    Effect.flatMap((plan) =>
      Effect.gen(function* () {
        const attributes = new Map<string, any>();

        const apply = Effect.fn(function* (
          id: string,
          node: PhysicalPlan[keyof PhysicalPlan],
        ) {
          if (attributes.has(node.resource.id)) {
            return attributes.get(node.resource.id);
          }

          if (node.action === "create") {
            if (node.bindings) {
              for (const binding of node.bindings) {
                yield* apply(binding.stmt.resource.id, binding.stmt);
              }
            }
            const response = yield* node.provider.create({
              id,
              news: node.news,
              bindings: node.bindings ?? [],
            });
            attributes.set(node.resource.id);
          }
        });

        for (const [id, node] of Object.entries(plan)) {
          yield* apply(id, node);
        }
        return plan as {
          [id in keyof P]: Simplify<P[id]["resource"]["attributes"]>;
          // [id in keyof P]: P[id]["attributes"];
        };
      }),
    ),
  ) as Effect.Effect<
    {
      [id in keyof P]: Simplify<P[id]["resource"]["attributes"]>;
    },
    Err,
    Req
  >;
