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

export type Materialized<A extends BindingAction> = A & {
  attributes: A["stmt"]["resource"]["attributes"];
};

export type BindingAction<Stmt extends Statement = Statement> =
  | AttachAction<Stmt>
  | DetachAction<Stmt>;

export type CreateAction<Stmt extends Statement = Statement> = {
  action: "create";
  news: any;
  provider: Provider;
  bindings?: AttachAction<Stmt>[];
};

export type UpdateAction<Stmt extends Statement = Statement> = {
  action: "update";
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings?: BindingAction<Stmt>[];
};

export type DeleteAction<Stmt extends Statement = Statement> = {
  action: "delete";
  olds: any;
  output: any;
  provider: Provider;
  bindings?: DetachAction<Stmt>[];
};

export type NoopAction = {
  action: "noop";
};

export type ReplaceAction<Stmt extends Statement = Statement> = {
  action: "replace";
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings?: BindingAction<Stmt>[];
};

export type ResourceAction<Stmt extends Statement = Statement> =
  | CreateAction<Stmt>
  | UpdateAction<Stmt>
  | DeleteAction<Stmt>
  | NoopAction
  | ReplaceAction<Stmt>;

export type Plan = {
  [id in string]: ResourceAction;
};

export type DeleteOrphans<K extends string | number | symbol> = {
  [k in Exclude<string, K>]: DeleteAction;
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
    [id in keyof Resources]: ResourceAction;
  } & DeleteOrphans<keyof Resources>,
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
                };
              } else if (diff.action === "replace") {
                plan[id] = {
                  action: "replace",
                  olds: oldState.props,
                  news: target.props,
                  output: oldState.output,
                  provider,
                };
              } else {
                plan[id] = {
                  action: "update",
                  olds: oldState.props,
                  news: target.props,
                  output: oldState.output,
                  provider,
                  bindings: bindingActions,
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
                  // TODO(sam): how to get these?
                  // provider,
                  // bindings,
                };
              }
            }),
          ),
        );

        return plan as {
          [id in keyof Resources]: ResourceAction;
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
