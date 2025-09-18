import * as Effect from "effect/Effect";
import { isBound, type Bound } from "./binding.ts";
import type { Statement } from "./policy.ts";
import type { Provider } from "./provider.ts";
import type { Resource } from "./resource.ts";
import { State, type ResourceState } from "./state.ts";
import type { TagInstance } from "./util.ts";

export type PlanError = never;

export type AttachAction<Stmt extends Statement = Statement> = {
  action: "attach";
  stmt: Stmt;
  olds?: Stmt;
};

export type DetachAction<Stmt extends Statement = Statement> = {
  action: "detach";
  stmt: Stmt;
};

export type BindingAction<Stmt extends Statement = Statement> =
  | AttachAction<Stmt>
  | DetachAction<Stmt>;

export declare namespace BindingAction {
  export type Materialized<A extends BindingAction> = A & {
    attributes: A["stmt"]["resource"]["attributes"];
  };
}

export type Create<R extends Resource> = {
  action: "create";
  resource: R;
  news: any;
  provider: Provider;
  bindings?: AttachAction[];
  attributes: R["attributes"];
};

export type Update<R extends Resource> = {
  action: "update";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings?: BindingAction[];
  attributes: R["attributes"];
};

export type Delete<R extends Resource> = {
  action: "delete";
  resource: R;
  olds: any;
  output: any;
  provider: Provider;
  bindings?: DetachAction[];
  attributes: R["attributes"];
};

export type Noop<R extends Resource> = {
  action: "noop";
  resource: R;
  attributes: R["attributes"];
};

export type Replace<R extends Resource> = {
  action: "replace";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings?: BindingAction[];
  attributes: R["attributes"];
};

export type Materialize<R extends Resource = Resource> =
  | Create<R>
  | Update<R>
  | Delete<R>
  | Replace<R>
  | Noop<R>;

export type PhysicalPlan = {
  [id in string]: Materialize & {
    attributes: unknown;
  };
};

export type Plan = {
  [id in string]: Materialize;
};

export type DeleteOrphans<K extends string | number | symbol> = {
  [k in Exclude<string, K>]: Delete<Resource>;
};

export const plan = <
  Resources extends {
    [id in string]: Bound | Resource;
  },
  Req,
>(
  resources: Effect.Effect<Resources, never, Req>,
): Effect.Effect<
  {
    [id in keyof Resources]: Resources[id] extends Bound<infer From, any>
      ? Materialize<From>
      : Resources[id] extends Resource
        ? Materialize<Resources[id]>
        : never;
  }, // & DeleteOrphans<keyof Resources>,
  PlanError,
  | Req
  // extract the providers from the deeply nested resources
  | {
      [id in keyof Resources]: Resources[id] extends Bound
        ?
            | TagInstance<Resources[id]["target"]["provider"]>
            | TagInstance<
                Resources[id]["bindings"][number]["resource"]["provider"]
              >
        : Resources[id] extends Resource
          ? TagInstance<Resources[id]["provider"]>
          : never;
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
          const oldState = yield* state.get(id);

          // TODO(sam): handle plain resources (no bindings)
          if (isBound(resource)) {
            const target = resource.target;

            const bindingActions = diffBindings(oldState, resource.bindings);

            // i need a way to dynamically resovle the tag for a resource
            const provider: Provider = yield* target.provider;

            if (oldState === undefined || oldState.status === "creating") {
              plan[id] = {
                action: "create",
                news: target.props,
                provider,
                resource: target,
                // phantom
                attributes: undefined!,
              };
            } else if (provider.diff) {
              const diff = yield* provider.diff({
                id,
                olds: oldState.props,
                news: target.props,
                output: oldState.output,
              });
              if (diff.action === "noop" && bindingActions.length === 0) {
                plan[id] = {
                  action: "noop",
                  resource: target,
                  // phantom
                  attributes: undefined!,
                };
              } else if (diff.action === "replace") {
                plan[id] = {
                  action: "replace",
                  olds: oldState.props,
                  news: target.props,
                  output: oldState.output,
                  provider,
                  resource: target,
                  // phantom
                  attributes: undefined!,
                };
              } else {
                plan[id] = {
                  action: "update",
                  olds: oldState.props,
                  news: target.props,
                  output: oldState.output,
                  provider,
                  bindings: bindingActions,
                  resource: target,
                  // phantom
                  attributes: undefined!,
                };
              }
            } else if (
              compare(oldState, target.props) ||
              bindingActions.length > 0
            ) {
              plan[id] = {
                action: "update",
                olds: oldState.props,
                news: target.props,
                output: oldState.output,
                provider,
                bindings: bindingActions,
                resource: target,
                // phantom
                attributes: undefined!,
              };
            } else {
              plan[id] = {
                action: "noop",
                resource: target,
                // phantom
                attributes: undefined!,
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
                  // TODO(sam): how to get these?
                  // provider,
                  // bindings,
                };
              }
            }),
          ),
        );

        return plan as {
          [id in keyof Resources]: any;
        } & DeleteOrphans<keyof Resources>;
      }),
    ),
  );

const compare = <R extends Resource>(
  oldState: ResourceState | undefined,
  newState: R["props"],
) => JSON.stringify(oldState?.props) === JSON.stringify(newState);

const diffBindings = (
  oldState: ResourceState | undefined,
  bindings: Statement[],
) => {
  const actions: BindingAction[] = [];
  const oldBindings = oldState?.bindings;
  const oldSids = new Set(oldBindings?.map((binding) => binding.sid));
  for (const stmt of bindings) {
    const sid = stmt.sid ?? `${stmt.effect}:${stmt.action}:${stmt.resource.id}`;
    oldSids.delete(sid);

    const oldBinding = oldBindings?.find((binding) => binding.sid === sid);
    if (!oldBinding) {
      actions.push({
        action: "attach",
        stmt,
      });
    } else if (isBindingDiff(oldBinding, stmt)) {
      actions.push({
        action: "attach",
        stmt,
        olds: oldBinding,
      });
    }
  }
  for (const sid of oldSids) {
    actions.push({
      action: "detach",
      stmt: oldBindings?.find((binding) => binding.sid === sid)!,
    });
  }
  return actions;
};

const isBindingDiff = (oldBinding: Statement, newBinding: Statement) =>
  oldBinding.effect !== newBinding.effect ||
  oldBinding.action !== newBinding.action ||
  oldBinding.resource.id !== newBinding.resource.id;
