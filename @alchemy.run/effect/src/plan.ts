import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Phase } from "./phase.ts";
import type { SerializedStatement, Statement } from "./policy.ts";
import type { Provider } from "./provider.ts";
import type { Resource } from "./resource.ts";
import type { Service } from "./service.ts";
import { State, type ResourceState } from "./state.ts";
import type { TagInstance } from "./tag-instance.ts";

export type PlanError = never;

export type BoundDecl<
  Host extends Service = Service,
  To extends Statement = Statement,
> = {
  type: "bound";
  resource: Host;
  bindings: To[];
  props: any;
};

export const isBoundDecl = (value: any): value is BoundDecl =>
  value && typeof value === "object" && value.type === "bound";

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
  attributes: Stmt["resource"]["Attr"];
};

export type Detach<Stmt extends Statement = Statement> = {
  action: "detach";
  stmt: Stmt;
  attributes: Stmt["resource"]["Attr"];
};

export type NoopBind<Stmt extends Statement = Statement> = {
  action: "noop";
  stmt: Stmt;
  attributes: Stmt["resource"]["Attr"];
  provider: Context.Tag<never, Binding>;
};

/**
 * A node in the plan that represents a resource CRUD operation.
 */
export type CrudNode<
  R extends Resource | Service = Resource | Service,
  B extends Statement = Statement,
> =
  | Create<R, B>
  | Update<R, B>
  | Delete<R, B>
  | Replace<R, B>
  | NoopUpdate<R, B>;

export type Create<
  R extends Resource | Service,
  B extends Statement = Statement,
> = {
  action: "create";
  resource: R;
  news: any;
  provider: Provider;
  bindings: Attach<B>[];
  attributes: R["attributes"];
};

export type Update<
  R extends Resource | Service,
  B extends Statement = Statement,
> = {
  action: "update";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: Provider;
  bindings: BindNode<B>[];
  attributes: R["attributes"];
};

export type Delete<
  R extends Resource | Service,
  _B extends Statement = Statement,
> = {
  action: "delete";
  resource: R;
  olds: any;
  output: any;
  provider: Provider;
  bindings: [];
  attributes: R["attributes"];
  downstream: string[];
};

export type NoopUpdate<
  R extends Resource | Service,
  B extends Statement = Statement,
> = {
  action: "noop";
  resource: R;
  attributes: R["attributes"];
  bindings: NoopBind<B>[];
};

export type Replace<
  R extends Resource | Service,
  B extends Statement = Statement,
> = {
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
    [id in string]: BoundDecl | Resource | Service;
  },
  never,
  any
>;

type ApplyAll<
  Items extends PlanItem[],
  Accum extends Record<string, CrudNode> = {},
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

type Apply<T, Stmt extends Statement = never> = T extends BoundDecl<
  infer From,
  infer Bindings extends Statement
>
  ? CrudNode<From, Bindings | Stmt>
  : T extends Resource
    ? CrudNode<T, Stmt>
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
  [id in string]: CrudNode;
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
                  [x: string]: Resource | BoundDecl | Service;
                }) {
                  return Object.fromEntries(
                    (yield* Effect.all(
                      Object.entries(subgraph).map(
                        Effect.fn(function* ([id, node]) {
                          const resource = isBoundDecl(node)
                            ? node.resource
                            : node;
                          const statements = isBoundDecl(node)
                            ? node.bindings
                            : [];
                          const news = isBoundDecl(node)
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
                    )).map((update) => [update.resource.ID, update]),
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
                [id in keyof Resources]: Resources[id] extends BoundDecl
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
                    ID: id,
                    Type: oldState.type,
                    Attr: oldState.output,
                    Props: oldState.props,
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
  newState: R["Props"],
) => JSON.stringify(oldState?.props) === JSON.stringify(newState);

const diffBindings = (
  oldState: ResourceState | undefined,
  bindings: Statement[],
) => {
  const actions: BindNode[] = [];
  const oldBindings = oldState?.bindings;
  const oldSids = new Set(oldBindings?.map((binding) => binding.sid));
  for (const stmt of bindings) {
    const sid = stmt.sid ?? `${stmt.effect}:${stmt.action}:${stmt.resource.ID}`;
    oldSids.delete(sid);

    const oldBinding = oldBindings?.find((binding) => binding.sid === sid);
    if (!oldBinding) {
      actions.push({
        action: "attach",
        stmt,
        // phantom
        attributes: stmt.resource.Attr,
      });
    } else if (isBindingDiff(oldBinding, stmt)) {
      actions.push({
        action: "attach",
        stmt,
        olds: oldBinding,
        // phantom
        attributes: stmt.resource.Attr,
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
  oldBinding.resource.id !== newBinding.resource.ID;
