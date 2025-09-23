import * as Effect from "effect/Effect";
import { isBound, type Bound } from "./binding.ts";
import type { SerializedStatement, Statement } from "./policy.ts";
import type { Provider } from "./provider.ts";
import type { Resource } from "./resource.ts";
import { State, type ResourceState } from "./state.ts";
import type { TagInstance } from "./util.ts";

export type PlanError = never;

export type AttachAction<Stmt extends Statement = Statement> = {
  action: "attach";
  stmt: Stmt;
  olds?: SerializedStatement<Stmt>;
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

type Apply<
  Items extends PlanItem[],
  Accum extends Record<string, Materialized> = {},
> = Items extends [
  infer Head extends PlanItem,
  ...infer Tail extends PlanItem[],
]
  ? Apply<
      Tail,
      Accum & {
        [id in keyof Effect.Effect.Success<Head>]: Materialize<
          Effect.Effect.Success<Head>[id],
          id extends keyof Accum ? Accum[id]["bindings"][number]["stmt"] : never
        >;
      }
    >
  : Accum;

export type AnyPlan = {
  [id in string]: Materialized;
};

export type Plan<
  Phase extends "update" | "destroy" = "update" | "destroy",
  Resources extends PlanItem[] = PlanItem[],
> = Phase extends "update"
  ?
      | {
          [k in keyof Apply<Resources>]: Apply<Resources>[k];
        }
      | {
          [k in Exclude<string, keyof Apply<Resources>>]: Delete<
            Resource,
            Statement
          >;
        }
  : {
      [k in Exclude<string, keyof Apply<Resources>>]: Delete<
        Resource,
        Statement
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
  const Phase extends "update" | "destroy",
  const Resources extends PlanItem[],
>({
  phase,
  resources,
}: {
  phase: Phase;
  resources: Resources;
}) => {
  return Effect.gen(function* () {
    const state = yield* State;

    const updates =
      phase === "update"
        ? yield* Effect.all(
            resources.map((resource) =>
              Effect.flatMap(
                resource,
                Effect.fn(function* (subgraph: {
                  [x: string]: Resource | Bound;
                }) {
                  const state = yield* State;

                  return Object.fromEntries(
                    (yield* Effect.all(
                      Object.entries(subgraph).map(
                        Effect.fn(function* ([id, node]) {
                          const resource = isBound(node) ? node.resource : node;
                          const statements = isBound(node) ? node.bindings : [];
                          const news = isBound(node)
                            ? node.props
                            : resource.props;

                          const oldState = yield* state.get(id);
                          const provider: Provider = yield* resource.provider;
                          const bindings = diffBindings(oldState, statements);

                          if (
                            oldState === undefined ||
                            oldState.status === "creating"
                          ) {
                            return {
                              action: "create",
                              news,
                              provider,
                              resource,
                              // phantom
                              attributes: undefined!,
                              bindings: bindings as AttachAction<Statement>[],
                            } satisfies Create<Resource, Statement>;
                          } else if (provider.diff) {
                            const diff = yield* provider.diff({
                              id,
                              olds: oldState.props,
                              news,
                              output: oldState.output,
                              bindings,
                            });
                            if (diff.action === "noop") {
                              return {
                                action: "noop",
                                resource,
                                // phantom
                                attributes: undefined!,
                                bindings: bindings as NoopAction<Statement>[],
                              };
                            } else if (diff.action === "replace") {
                              return {
                                action: "replace",
                                olds: oldState.props,
                                news,
                                output: oldState.output,
                                provider,
                                resource,
                                // phantom
                                attributes: undefined!,
                                bindings: bindings,
                              };
                            } else {
                              return {
                                action: "update",
                                olds: oldState.props,
                                news,
                                output: oldState.output,
                                provider,
                                resource,
                                // phantom
                                attributes: undefined!,
                                bindings: bindings,
                              };
                            }
                          } else if (compare(oldState, resource.props)) {
                            return {
                              action: "update",
                              olds: oldState.props,
                              news,
                              output: oldState.output,
                              provider,
                              bindings,
                              resource,
                              // phantom
                              attributes: undefined!,
                            };
                          } else {
                            return {
                              action: "noop",
                              resource,
                              // phantom
                              attributes: undefined!,
                              bindings: bindings as NoopAction<Statement>[],
                            };
                          }
                        }),
                      ),
                    )).map((update) => [update.resource.id, update]),
                  ) as AnyPlan;
                }),
              ),
            ),
          ) as Effect.Effect<
            {
              [id in keyof Resources]: Materialize<Resources[id]>;
            }, // & DeleteOrphans<keyof Resources>,
            PlanError,
            // | Req
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
          >
        : [];

    const deletions = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list()).map(
          Effect.fn(function* (id) {
            if (id in updates) {
              return;
            }
            const oldState = yield* state.get(id);
            const context = yield* Effect.context<never>();
            if (oldState) {
              const provider = context.unsafeMap.get(oldState?.type);
              if (!provider) {
                yield* Effect.die(
                  new Error(`Provider not found for ${oldState?.type}`),
                );
              }
              // TODO(sam): deletion ordering
              return [
                id,
                {
                  action: "delete",
                  olds: oldState.props,
                  output: oldState.output,
                  // TODO(sam): how to get these?
                  provider,
                  attributes: oldState?.output,
                  // bindings: oldState?.bindings,
                  // TODO(sam): Support Detach Bindings
                  bindings: [],
                  resource: {
                    id,
                    type: oldState.type,
                    attributes: oldState.output,
                    props: oldState.props,
                    provider,
                  },
                } satisfies Delete<Resource>,
              ] as const;
            }
          }),
        ),
      )).filter((v) => !!v),
    );

    return [...updates, deletions].reduce(
      (acc, plan) => ({ ...acc, ...plan }),
      {} as any,
    );
  }) as Effect.Effect<
    Plan<Phase, Resources>,
    never,
    Effect.Effect.Context<Resources[number]> | State
  >;
};

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
  // for (const sid of oldSids) {
  //   actions.push({
  //     action: "detach",
  //     stmt: oldBindings?.find((binding) => binding.sid === sid)!,
  //   });
  // }
  return actions;
};

const isBindingDiff = (
  oldBinding: SerializedStatement,
  newBinding: Statement,
) =>
  oldBinding.effect !== newBinding.effect ||
  oldBinding.action !== newBinding.action ||
  oldBinding.resource.id !== newBinding.resource.id;

export const displayPlan = (plan: AnyPlan) => {
  return Object.entries(plan).forEach(([id, node]) => {
    console.log(`[${node.action}] ${node.resource.type} ${id}`);
  });
};
