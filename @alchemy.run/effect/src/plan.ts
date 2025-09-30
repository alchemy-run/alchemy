import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isBinding, type Binder, type Binding } from "./binding.ts";
import type { Phase } from "./phase.ts";
import type { SerializedStatement, Statement } from "./policy.ts";
import type { Provider } from "./provider.ts";
import type { Resource } from "./resource.ts";
import { State, type ResourceState } from "./state.ts";
import type { TagInstance } from "./tag-instance.ts";

export type PlanError = never;

/**
 * A node in the plan that represents a binding operation acting on a resource.
 */
export type BindNode<Stmt extends Statement = Statement> =
  | Attach<Stmt>
  | Detach<Stmt>
  | NoopBind<Stmt>;

export type Attach<Stmt extends Statement = Statement> = {
  action: "attach";
  stmt: Stmt;
  olds?: SerializedStatement<Stmt>;
  attributes: Stmt["resource"]["attributes"];
};

export type Detach<Stmt extends Statement = Statement> = {
  action: "detach";
  stmt: Stmt;
  attributes: Stmt["resource"]["attributes"];
};

export type NoopBind<Stmt extends Statement = Statement> = {
  action: "noop";
  stmt: Stmt;
  attributes: Stmt["resource"]["attributes"];
  provider: Context.Tag<never, Binder>;
};

/**
 * A node in the plan that represents a resource CRUD operation.
 */
export type ResourceNode<
  R extends Resource = Resource,
  B extends Statement = Statement,
> =
  | Create<R, B>
  | Update<R, B>
  | Delete<R, B>
  | Replace<R, B>
  | NoopUpdate<R, B>;

export type Create<R extends Resource, B extends Statement = Statement> = {
  action: "create";
  resource: R;
  news: any;
  provider: Provider;
  bindings: Attach<B>[];
  attributes: R["attributes"];
};

export type Update<R extends Resource, B extends Statement = Statement> = {
  action: "update";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings: BindNode<B>[];
  attributes: R["attributes"];
};

export type Delete<R extends Resource, _B extends Statement = Statement> = {
  action: "delete";
  resource: R;
  olds: any;
  output: any;
  provider: Provider;
  bindings: [];
  attributes: R["attributes"];
  downstream: string[];
};

export type NoopUpdate<R extends Resource, B extends Statement = Statement> = {
  action: "noop";
  resource: R;
  attributes: R["attributes"];
  bindings: NoopBind<B>[];
};

export type Replace<R extends Resource, B extends Statement = Statement> = {
  action: "replace";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings: BindNode<B>[];
  attributes: R["attributes"];
  deleteFirst?: boolean;
};

type PlanItem = Effect.Effect<
  {
    [id in string]: Binding | Resource;
  },
  never,
  any
>;

type ApplyAll<
  Items extends PlanItem[],
  Accum extends Record<string, ResourceNode> = {},
> = Items extends [
  infer Head extends PlanItem,
  ...infer Tail extends PlanItem[],
]
  ? ApplyAll<
      Tail,
      Accum & {
        [id in keyof Effect.Effect.Success<Head>]: Apply<
          Effect.Effect.Success<Head>[id],
          id extends keyof Accum ? Accum[id]["bindings"][number]["stmt"] : never
        >;
      }
    >
  : Accum;

type Apply<T, Stmt extends Statement = never> = T extends Binding<
  infer From,
  infer Bindings extends Statement
>
  ? ResourceNode<From, Bindings | Stmt>
  : T extends Resource
    ? ResourceNode<T, Stmt>
    : never;

type DerivePlan<
  P extends Phase = Phase,
  Resources extends PlanItem[] = PlanItem[],
> = P extends "update"
  ?
      | {
          [k in keyof ApplyAll<Resources>]: ApplyAll<Resources>[k];
        }
      | {
          [k in Exclude<string, keyof ApplyAll<Resources>>]: Delete<
            Resource,
            Statement
          >;
        }
  : {
      [k in Exclude<string, keyof ApplyAll<Resources>>]: Delete<
        Resource,
        Statement
      >;
    };

export type Plan = {
  [id in string]: ResourceNode;
};

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

    const resourceIds = yield* state.list();
    const resourcesState = yield* Effect.all(
      resourceIds.map((id) => state.get(id)),
    );
    // map of resource ID -> its downstream dependencies (resources that depend on it)
    const downstream = resourcesState
      .filter(
        (
          resource,
        ): resource is ResourceState & {
          bindings: SerializedStatement[];
        } => !!resource?.bindings,
      )
      .flatMap((resource) =>
        resource.bindings.map((binding) => [binding.resource.id, resource.id]),
      )
      .reduce(
        (acc, [id, resourceId]) => ({
          ...acc,
          [id]: [...(acc[id] ?? []), resourceId],
        }),
        {} as Record<string, string[]>,
      );

    const updates = (
      phase === "update"
        ? yield* Effect.all(
            resources.map((resource) =>
              Effect.flatMap(
                resource,
                Effect.fn(function* (subgraph: {
                  [x: string]: Resource | Binding;
                }) {
                  return Object.fromEntries(
                    (yield* Effect.all(
                      Object.entries(subgraph).map(
                        Effect.fn(function* ([id, node]) {
                          const resource = isBinding(node)
                            ? node.resource
                            : node;
                          const statements = isBinding(node)
                            ? node.bindings
                            : [];
                          const news = isBinding(node)
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
                              bindings: bindings as Attach<Statement>[],
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
                                bindings: bindings as NoopBind<Statement>[],
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
                              bindings: bindings as NoopBind<Statement>[],
                            };
                          }
                        }),
                      ),
                    )).map((update) => [update.resource.id, update]),
                  ) as Plan;
                }),
              ),
            ),
          ) as Effect.Effect<
            {
              [id in keyof Resources]: Apply<Resources[id]>;
            }, // & DeleteOrphans<keyof Resources>,
            PlanError,
            // | Req
            | State
            // extract the providers from the deeply nested resources
            | {
                [id in keyof Resources]: Resources[id] extends Binding
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
        : []
    ).reduce((acc, update: any) => ({ ...acc, ...update }), {} as Plan);

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
              return [
                id,
                {
                  action: "delete",
                  olds: oldState.props,
                  output: oldState.output,
                  provider,
                  attributes: oldState?.output,
                  // TODO(sam): Support Detach Bindings
                  bindings: [],
                  resource: {
                    id,
                    type: oldState.type,
                    attributes: oldState.output,
                    props: oldState.props,
                    provider,
                  },
                  downstream: downstream[id] ?? [],
                } satisfies Delete<Resource>,
              ] as const;
            }
          }),
        ),
      )).filter((v) => !!v),
    );

    for (const [resourceId, deletion] of Object.entries(deletions)) {
      const dependencies = deletion.downstream.filter((d) => d in updates);
      if (dependencies.length > 0) {
        return yield* Effect.fail(
          new DeleteResourceHasDownstreamDependencies({
            message: `Resource ${resourceId} has downstream dependencies`,
            resourceId,
            dependencies,
          }),
        );
      }
    }

    return [updates, deletions].reduce(
      (acc, plan) => ({ ...acc, ...plan }),
      {} as any,
    );
  }) as Effect.Effect<
    DerivePlan<Phase, Resources>,
    never,
    Effect.Effect.Context<Resources[number]> | State
  >;
};

class DeleteResourceHasDownstreamDependencies extends Data.TaggedError(
  "DeleteResourceHasDownstreamDependencies",
)<{
  message: string;
  resourceId: string;
  dependencies: string[];
}> {}

const compare = <R extends Resource>(
  oldState: ResourceState | undefined,
  newState: R["props"],
) => JSON.stringify(oldState?.props) === JSON.stringify(newState);

const diffBindings = (
  oldState: ResourceState | undefined,
  bindings: Statement[],
) => {
  const actions: BindNode[] = [];
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
        // phantom
        attributes: stmt.resource.attributes,
      });
    } else if (isBindingDiff(oldBinding, stmt)) {
      actions.push({
        action: "attach",
        stmt,
        olds: oldBinding,
        // phantom
        attributes: stmt.resource.attributes,
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
