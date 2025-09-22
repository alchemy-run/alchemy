import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import type { BindingAction, Plan } from "./plan.ts";
import type { Statement } from "./policy.ts";

export const apply = <P extends Plan, Err, Req>(
  plan: Effect.Effect<P, Err, Req>,
) =>
  plan.pipe(
    Effect.flatMap((plan) =>
      Effect.gen(function* () {
        const outputs = {} as Record<string, Effect.Effect<any, any>>;

        const apply = Effect.fn(function* (
          node: BindingAction<Statement>[] | Plan[keyof Plan],
        ) {
          if (Array.isArray(node)) {
            return yield* Effect.all(
              node.map((binding) => {
                const resource = plan[binding.stmt.resource.id];
                return !resource
                  ? Effect.dieMessage(
                      `Resource ${binding.stmt.resource.id} not found`,
                    )
                  : apply(resource);
              }),
            );
          }
          const id = node.resource.id;
          return yield* (outputs[id] ??= yield* Effect.cached(
            Effect.gen(function* () {
              // TODO(sam): replace with an event emitter to support different CLI plugins
              yield* Console.log("pending", id);
              const bindings = yield* apply(node.bindings);
              if (node.action === "noop") {
                yield* Console.log("noop", id);
                return node.output;
              } else if (node.action === "create") {
                yield* Console.log("creating", id);
                return yield* node.provider.create({
                  id,
                  news: node.news,
                  bindings: node.bindings.map((binding, i) =>
                    Object.assign(binding, {
                      attributes: bindings[i],
                    }),
                  ),
                });
              } else if (node.action === "update") {
                yield* Console.log("updating", id);
                return yield* node.provider.update({
                  id,
                  news: node.news,
                  olds: node.olds,
                  output: node.output,
                  bindings: node.bindings.map((binding, i) =>
                    Object.assign(binding, {
                      attributes: bindings[i],
                    }),
                  ),
                });
              } else if (node.action === "delete") {
                yield* Console.log("deleting", id);
                return yield* node.provider.delete({
                  id,
                  olds: node.olds,
                  output: node.output,
                  bindings: node.bindings.map((binding, i) =>
                    Object.assign(binding, {
                      attributes: bindings[i],
                    }),
                  ),
                });
              } else if (node.action === "replace") {
                yield* Console.log("replacing", id);
                const destroy = node.provider.delete({
                  id,
                  olds: node.olds,
                  output: node.output,
                  bindings: node.bindings.map((binding, i) =>
                    Object.assign(binding, {
                      attributes: bindings[i],
                    }),
                  ),
                });
                const create = node.provider.create({
                  id,
                  news: node.news,
                  bindings: node.bindings.map((binding, i) =>
                    Object.assign(binding, {
                      attributes: bindings[i],
                    }),
                  ),
                });
                if (!node.deleteFirst) {
                  const outputs = yield* create;
                  yield* destroy;
                  return outputs;
                } else {
                  yield* destroy;
                  return yield* create;
                }
              }
            }).pipe(Effect.tap(() => Console.log(`${node.action}d ${id}`))),
          ));
        }) as (
          node: Plan[keyof Plan] | BindingAction<Statement>[],
        ) => Effect.Effect<any, never, never>;

        yield* Effect.all(Object.values(plan).map(apply));

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
