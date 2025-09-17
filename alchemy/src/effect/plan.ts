import * as Effect from "effect/Effect";
import { isBound, type Bound } from "./binding.ts";
import type { Provider } from "./provider.ts";
import type {
  ExtractProvider,
  Resource,
  ResourceWithProvider,
} from "./resource.ts";
import { State, type ResourceState } from "./state.ts";

export type PlanError = never;

export type Plan = {
  [id in string]:
    | {
        action: "create";
        news: any;
      }
    | {
        action: "update";
        olds: any;
        news: any;
        output: any;
      }
    | {
        action: "delete";
        olds: any;
        output: any;
      }
    | {
        action: "noop";
      }
    | {
        action: "replace";
        olds: any;
        news: any;
        output: any;
      };
};

export const plan = <
  Resources extends {
    [id in string]: Bound | Resource;
  },
  Req,
>(
  resources: Effect.Effect<Resources, never, Req>,
): Effect.Effect<
  Resources,
  PlanError,
  | Req
  // extract the providers from the deeply nested resources
  | {
      [id in keyof Resources]: Resources[id] extends Bound
        ?
            | ExtractProvider<Resources[id]["target"]>
            | ExtractProvider<Resources[id]["bindings"][number]["resource"]>
        : ExtractProvider<Resources[id]>;
    }[keyof Resources]
> =>
  resources.pipe(
    Effect.flatMap((resources) =>
      Effect.gen(function* () {
        const state = yield* State;
        const plan: Plan = {};
        const all = new Set(yield* state.list());
        for (const [id, resource] of Object.entries(resources)) {
          all.delete(id);
          if (isBound(resource)) {
            const target = resource.target as ResourceWithProvider;
            const bindings = resource.bindings;
            // i need a way to dynamically resovle the tag for a resource
            const provider: Provider = yield* target.provider;

            for (const binding of bindings) {
              const bindingProvider = yield* (
                binding.resource as ResourceWithProvider
              ).provider;
            }

            const oldState = yield* state.get(id);

            if (oldState === undefined || oldState.status === "creating") {
              plan[id] = {
                action: "create",
                news: target.props,
              };
            } else if (provider.diff) {
              const diff = yield* provider.diff({
                id,
                olds: oldState.props,
                news: target.props,
                output: oldState.output,
              });
              if (diff.action === "noop") {
                plan[id] = {
                  action: "noop",
                };
              } else if (diff.action === "replace") {
                plan[id] = {
                  action: "replace",
                  olds: oldState.props,
                  news: target.props,
                  output: oldState.output,
                };
              } else {
                plan[id] = {
                  action: diff.action,
                  olds: oldState.props,
                  news: target.props,
                  output: oldState.output,
                };
              }
            } else if (compare(oldState, target.props)) {
              plan[id] = {
                action: "update",
                olds: oldState.props,
                news: target.props,
                output: oldState.output,
              };
            } else {
              plan[id] = {
                action: "noop",
              };
            }
          }
        }
        yield* Effect.all(
          Array.from(all).map(
            Effect.fn(function* (id) {
              const oldState = yield* state.get(id);
              if (oldState) {
                plan[id] = {
                  action: "delete",
                  olds: oldState.props,
                  output: oldState.output,
                };
              }
            }),
          ),
        );

        return resources;
      }),
    ),
  );

const compare = <R extends Resource>(
  oldState: ResourceState | undefined,
  newState: R["props"],
) => JSON.stringify(oldState?.props) === JSON.stringify(newState);
