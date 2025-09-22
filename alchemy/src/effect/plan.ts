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

export type NoopAction<Stmt extends Statement = Statement> = {
  action: "noop";
  stmt: Stmt;
};

export type BindingAction<Stmt extends Statement = Statement> =
  | AttachAction<Stmt>
  | DetachAction<Stmt>
  | NoopAction<Stmt>;

export declare namespace BindingAction {
  export type Materialized<A extends BindingAction> = A & {
    attributes: A["stmt"]["resource"]["attributes"];
  };
}

export type Create<R extends Resource, B extends Statement = Statement> = {
  action: "create";
  resource: R;
  news: any;
  provider: Provider;
  bindings: AttachAction<B>[];
  attributes: R["attributes"];
};

export type Update<R extends Resource, B extends Statement = Statement> = {
  action: "update";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings: BindingAction<B>[];
  attributes: R["attributes"];
};

export type Delete<R extends Resource, B extends Statement = Statement> = {
  action: "delete";
  resource: R;
  olds: any;
  output: any;
  provider: Provider;
  bindings: DetachAction<B>[];
  attributes: R["attributes"];
};

export type Noop<R extends Resource, B extends Statement = Statement> = {
  action: "noop";
  resource: R;
  attributes: R["attributes"];
  bindings: NoopAction<B>[];
};

export type Replace<R extends Resource, B extends Statement = Statement> = {
  action: "replace";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings: BindingAction<B>[];
  attributes: R["attributes"];
  deleteFirst?: boolean;
};

export type Materialized<
  R extends Resource = Resource,
  B extends Statement = Statement,
> = Create<R, B> | Update<R, B> | Delete<R, B> | Replace<R, B> | Noop<R, B>;

export type Materialize<T, Stmt extends Statement = never> = T extends Bound<
  infer From,
  infer Bindings extends Statement
>
  ? Materialized<From, Bindings | Stmt>
  : T extends Resource
    ? Materialized<T, Stmt>
    : never;

export type Plan = {
  [id in string]: Materialized;
};

export type DeleteOrphans<K extends string | number | symbol> = {
  [k in Exclude<string, K>]: Delete<Resource>;
};

export const planAll = <const Resources extends PlanItem[]>(
  ...resources: Resources
) => {
  type Plan<
    Items extends PlanItem[],
    Accum extends Record<string, Materialized> = {},
  > = Items extends [
    infer Head extends PlanItem,
    ...infer Tail extends PlanItem[],
  ]
    ? Plan<
        Tail,
        Accum & {
          [id in keyof Effect.Effect.Success<Head>]: Materialize<
            Effect.Effect.Success<Head>[id],
            id extends keyof Accum
              ? Accum[id]["bindings"][number]["stmt"]
              : never
          >;
        }
      >
    : Accum;

  return Effect.all(resources.map((resource) => plan(resource))).pipe(
    Effect.map((plans) =>
      plans.reduce((acc, plan) => ({ ...acc, ...plan }), {}),
    ),
  ) as Effect.Effect<
    {
      [k in keyof Plan<Resources>]: Plan<Resources>[k];
    },
    never,
    Effect.Effect.Context<Resources[number]> | State
  >;
};

type PlanItem = Effect.Effect<
  {
    [id in string]: Bound | Resource;
  },
  never,
  any
>;

export const plan = <
  Resources extends {
    [id in string]: Bound | Resource;
  },
  Req,
>(
  resource: Effect.Effect<Resources, never, Req>,
): Effect.Effect<
  {
    [id in keyof Resources]: Materialize<Resources[id]>;
  }, // & DeleteOrphans<keyof Resources>,
  PlanError,
  | Req
  | State
  // extract the providers from the deeply nested resources
  | {
      [id in keyof Resources]: Resources[id] extends Bound
        ?
            | TagInstance<Resources[id]["resource"]["provider"]>
            | TagInstance<
                Resources[id]["bindings"][number]["resource"]["provider"]
              >
        : Resources[id] extends Resource
          ? TagInstance<Resources[id]["provider"]>
          : never;
    }[keyof Resources]
> =>
  resource.pipe(
    Effect.flatMap((resources) =>
      Effect.gen(function* () {
        const state = yield* State;
        const plan: Plan = {};
        const all = new Set(yield* state.list());
        for (const [id, node] of Object.entries(resources)) {
          all.delete(id);

          const resource = isBound(node) ? node.resource : node;
          const statements = isBound(node) ? node.bindings : [];
          const news = isBound(node) ? node.props : resource.props;

          const oldState = yield* state.get(id);
          const provider: Provider = yield* resource.provider;
          const bindings = diffBindings(oldState, statements);

          if (oldState === undefined || oldState.status === "creating") {
            plan[id] = {
              action: "create",
              news,
              provider,
              resource: resource,
              // phantom
              attributes: undefined!,
              bindings: bindings as AttachAction<Statement>[],
            };
          } else if (provider.diff) {
            const diff = yield* provider.diff({
              id,
              olds: oldState.props,
              news,
              output: oldState.output,
            });
            if (diff.action === "noop" && bindings.length === 0) {
              plan[id] = {
                action: "noop",
                resource: resource,
                // phantom
                attributes: undefined!,
                bindings: bindings as NoopAction<Statement>[],
              };
            } else if (diff.action === "replace") {
              plan[id] = {
                action: "replace",
                olds: oldState.props,
                news,
                output: oldState.output,
                provider,
                resource: resource,
                // phantom
                attributes: undefined!,
                bindings: bindings,
              };
            } else {
              plan[id] = {
                action: "update",
                olds: oldState.props,
                news,
                output: oldState.output,
                provider,
                resource: resource,
                // phantom
                attributes: undefined!,
                bindings: bindings,
              };
            }
          } else if (compare(oldState, resource.props) || bindings.length > 0) {
            plan[id] = {
              action: "update",
              olds: oldState.props,
              news,
              output: oldState.output,
              provider,
              bindings,
              resource: resource,
              // phantom
              attributes: undefined!,
            };
          } else {
            plan[id] = {
              action: "noop",
              resource: resource,
              // phantom
              attributes: undefined!,
              bindings: bindings as NoopAction<Statement>[],
            };
          }
        }
        yield* Effect.all(
          Array.from(all).map(
            Effect.fn(function* (id) {
              const oldState = yield* state.get(id);
              const context = yield* Effect.context<never>();
              if (oldState) {
                const provider = context.unsafeMap.get(oldState?.type);
                if (!provider) {
                  yield* Effect.die(
                    new Error(`Provider not found for ${oldState?.type}`),
                  );
                }
                plan[id] = {
                  action: "delete",
                  olds: oldState.props,
                  output: oldState.output,
                  // TODO(sam): how to get these?
                  provider,
                  attributes: oldState?.output,
                  // bindings,
                  // resource,
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

export const displayPlan = (plan: Plan) => {
  return Object.entries(plan).forEach(([id, node]) => {
    console.log(`[${node.action}] ${node.resource.type} ${id}`);
  });
};
