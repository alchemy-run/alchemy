import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import type { AnyPlan, BindingAction, Delete } from "./plan.ts";
import type { Statement } from "./policy.ts";
import type { Resource } from "./resource.ts";
import { State } from "./state.ts";

export const apply = <const P extends AnyPlan, Err, Req>(
  plan: Effect.Effect<P, Err, Req>,
) =>
  plan.pipe(
    Effect.flatMap((plan) =>
      Effect.gen(function* () {
        const state = yield* State;
        const outputs = {} as Record<string, Effect.Effect<any, any>>;

        const apply = Effect.fn(function* (
          node: BindingAction<Statement>[] | Exclude<P[keyof P], undefined>,
        ) {
          if (Array.isArray(node)) {
            return yield* Effect.all(
              node.map((binding) => {
                const resource = plan[binding.stmt.resource.id];
                return !resource
                  ? Effect.dieMessage(
                      `Resource ${binding.stmt.resource.id} not found`,
                    )
                  : apply(resource as P[keyof P]);
              }),
            );
          }

          const checkpoint = <Out, Err>(
            effect: Effect.Effect<Out, Err, never>,
          ) =>
            effect.pipe(
              Effect.flatMap((output) =>
                state
                  .set(node.resource.id, {
                    id: node.resource.id,
                    type: node.resource.type,
                    status: node.action === "create" ? "created" : "updated",
                    props: node.resource.props,
                    output,
                    bindings: node.bindings.map((binding) => ({
                      ...binding.stmt,
                      resource: {
                        type: node.resource.type,
                        id: node.resource.id,
                      },
                    })),
                  })
                  .pipe(Effect.map(() => output)),
              ),
            );

          const hydrate = <A extends BindingAction<Statement>>(
            bindings: Statement[],
          ) =>
            node.bindings.map(
              (binding, i) =>
                Object.assign(binding, {
                  attributes: bindings[i],
                }) as A & {
                  attributes: any;
                },
            );

          const id = node.resource.id;
          return yield* (outputs[id] ??= yield* Effect.cached(
            Effect.gen(function* () {
              // TODO(sam): replace with an event emitter to support different CLI plugins
              yield* Console.log("pending", id);
              const bindings = yield* apply(node.bindings);
              if (node.action === "noop") {
                yield* Console.log("noop", id);
                return (yield* state.get(id))?.output;
              } else if (node.action === "create") {
                yield* Console.log("creating", id);
                return yield* node.provider
                  .create({
                    id,
                    news: node.news,
                    bindings: hydrate(bindings),
                  })
                  .pipe(checkpoint);
              } else if (node.action === "update") {
                yield* Console.log("updating", id);
                return yield* node.provider
                  .update({
                    id,
                    news: node.news,
                    olds: node.olds,
                    output: node.output,
                    bindings: hydrate(bindings),
                  })
                  .pipe(checkpoint);
              } else if (node.action === "delete") {
                yield* Console.log("deleting", id);
                return yield* node.provider
                  .delete({
                    id,
                    olds: node.olds,
                    output: node.output,
                    bindings: node.bindings.map((binding, i) =>
                      Object.assign(binding, {
                        attributes: bindings[i],
                      }),
                    ),
                  })
                  .pipe(Effect.flatMap(() => state.delete(id)));
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
                const create = node.provider
                  .create({
                    id,
                    news: node.news,
                    // TODO(sam): these need to only include attach actions
                    // @ts-expect-error
                    bindings: node.bindings.map((binding, i) =>
                      Object.assign(binding, {
                        attributes: bindings[i],
                      }),
                    ),
                  })
                  // TODO(sam): delete and create will conflict here, we need to extend the state store for replace
                  .pipe(checkpoint);
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
          node: P[keyof P] | BindingAction<Statement>[],
        ) => Effect.Effect<any, never, never>;

        const resources: any = Object.fromEntries(
          yield* Effect.all(
            Object.entries(plan).map(
              Effect.fn(function* ([id, node]) {
                return [id, yield* apply(node as P[keyof P])];
              }),
            ),
          ),
        );
        if (
          Object.values(plan).every((resource) => resource.action === "delete")
        ) {
          return undefined;
        }
        return resources;
      }),
    ),
  ) as Effect.Effect<
    {
      [id in keyof P]: P[id] extends
        | Delete<Resource, Statement>
        | undefined
        | never
        ? never
        : Simplify<P[id]["resource"]["attributes"]>;
    } extends infer O
      ? O extends {
          [key: string]: never;
        }
        ? undefined
        : O
      : never,
    Err,
    Req
  >;
