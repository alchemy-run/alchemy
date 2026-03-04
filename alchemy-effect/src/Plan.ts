import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { asEffect } from ".//Util/types.ts";
import type { NoopDiff, UpdateDiff } from "./Diff.ts";
import { InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import {
  getProviderByType,
  Provider,
  type ProviderService,
} from "./Provider.ts";
import type { ResourceBinding, ResourceLike } from "./Resource.ts";
import { type StackSpec } from "./Stack.ts";
import {
  State,
  type CreatedResourceState,
  type CreatingResourceState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type UpdatedResourceState,
  type UpdatingReourceState,
} from "./State/index.ts";

export type PlanError = never;

export const isCRUD = (node: any): node is CRUD => {
  return (
    node &&
    typeof node === "object" &&
    (node.action === "create" ||
      node.action === "update" ||
      node.action === "replace" ||
      node.action === "noop")
  );
};

/**
 * A node in the plan that represents a resource CRUD operation.
 */
export type CRUD<R extends ResourceLike = any> =
  | Create<R>
  | Update<R>
  | Delete<R>
  | Replace<R>
  | NoopUpdate<R>;

export type Apply<R extends ResourceLike = ResourceLike> =
  | Create<R>
  | Update<R>
  | Replace<R>
  | NoopUpdate<R>;

export type BindingAction = "create" | "update" | "delete" | "noop";

export interface BindingNode<Args extends any[]> {
  action: BindingAction;
  sid: string;
  args: Args;
}

export interface BaseNode<
  R extends ResourceLike<string> = ResourceLike<string>,
> {
  resource: R;
  provider: ProviderService<R>;
  downstream: string[];
  bindings: BindingNode<R["Binding"]>[];
}

export interface Create<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "create";
  props: R["Props"];
  state: CreatingResourceState | undefined;
}

export interface Update<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "update";
  props: R["Props"];
  state:
    | CreatedResourceState
    | UpdatedResourceState
    | UpdatingReourceState
    // the props can change after creating the replacement resource,
    // so Apply needs to handle updates and then continue with cleaning up the replaced graph
    | ReplacedResourceState;
}

export interface Delete<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "delete";
  // a resource can be deleted no matter what state it's in
  state: ResourceState;
}

export interface NoopUpdate<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "noop";
  state: CreatedResourceState | UpdatedResourceState;
}

export interface Replace<
  R extends ResourceLike = ResourceLike,
> extends BaseNode<R> {
  action: "replace";
  props: any;
  deleteFirst: boolean;
  state:
    | CreatingResourceState
    | CreatedResourceState
    | UpdatingReourceState
    | UpdatedResourceState
    | ReplacingResourceState
    | ReplacedResourceState;
}

export type Plan<Output = any> = {
  resources: {
    [id in string]: Apply<any>;
  };
  deletions: {
    [id in string]?: Delete<ResourceLike>;
  };
  output: Output;
};

export const make = <A>(
  stack: StackSpec<A>,
): Effect.Effect<Plan<A>, never, State> =>
  // @ts-expect-error
  Effect.gen(function* () {
    const state = yield* State;

    const resources = Object.values(stack.resources);

    // TODO(sam): rename terminology to Stack
    const stackName = stack.name;
    const stage = stack.stage;

    const resourceIds = yield* state.list({
      stack: stackName,
      stage: stage,
    });
    const oldResources = yield* Effect.all(
      resourceIds.map((id) =>
        state.get({ stack: stackName, stage: stage, logicalId: id }),
      ),
      { concurrency: "unbounded" },
    );

    const resolvedResources: Record<string, Effect.Effect<any>> = {};

    const resolveResource = (
      resourceExpr: Output.ResourceExpr<any, any>,
    ): Effect.Effect<any> =>
      Effect.gen(function* () {
        // @ts-expect-error
        return yield* (resolvedResources[resourceExpr.src.LogicalId] ??=
          yield* Effect.cached(
            Effect.gen(function* () {
              const resource = resourceExpr.src;
              const provider =
                yield* resource.Provider as any as Effect.Effect<ProviderService>;
              const props = yield* resolveInput(resource.Props);
              const oldState = yield* state.get({
                stack: stackName,
                stage: stage,
                logicalId: resource.LogicalId,
              });

              if (!oldState || oldState.status === "creating") {
                return resourceExpr;
              }

              const oldProps =
                oldState.status === "created" ||
                oldState.status === "updated" ||
                oldState.status === "replaced"
                  ? // if we're in a stable state, then just use the props
                    oldState.props
                  : // if we failed to update or replace, compare with the last known stable props
                    oldState.status === "updating" ||
                      oldState.status === "replacing"
                    ? oldState.old.props
                    : // TODO(sam): it kinda doesn't make sense to diff with a "deleting" state
                      oldState.props;

              const oldBindings = oldState.bindings ?? [];
              const newBindings = stack.bindings[resource.LogicalId] ?? [];

              const diff = yield* provider.diff
                ? provider
                    .diff({
                      id: resource.LogicalId,
                      olds: oldProps,
                      instanceId: oldState.instanceId,
                      news: props,
                      output: oldState.attr,
                      oldBindings,
                      newBindings,
                    })
                    .pipe(
                      Effect.provideService(InstanceId, oldState.instanceId),
                    )
                : Effect.succeed(undefined);

              const stables: string[] = [
                ...(provider.stables ?? []),
                ...(diff?.stables ?? []),
              ];

              const withStables = (output: any) =>
                stables.length > 0
                  ? new Output.ResourceExpr(
                      resourceExpr.src,
                      Object.fromEntries(
                        stables.map((stable) => [stable, output?.[stable]]),
                      ),
                    )
                  : // if there are no stable properties, treat every property as changed
                    resourceExpr;

              if (diff == null) {
                if (arePropsChanged(oldProps, props)) {
                  // the props have changed but the provider did not provide any hints as to what is stable
                  // so we must assume everything has changed
                  return withStables(oldState?.attr);
                }
              } else if (diff.action === "update") {
                return withStables(oldState?.attr);
              } else if (diff.action === "replace") {
                return resourceExpr;
              }
              if (
                oldState.status === "created" ||
                oldState.status === "updated" ||
                oldState.status === "replaced"
              ) {
                // we can safely return the attributes if we know they have stabilized
                return oldState?.attr;
              } else {
                // we must assume the resource doesn't exist if it hasn't stabilized
                return resourceExpr;
              }
            }),
          ));
      });

    const resolveInput = (input: any): Effect.Effect<any> =>
      Effect.gen(function* () {
        if (!input) {
          return input;
        } else if (Output.isExpr(input)) {
          return yield* resolveOutput(input);
        } else if (Array.isArray(input)) {
          return yield* Effect.all(input.map(resolveInput), {
            concurrency: "unbounded",
          });
        } else if (typeof input === "object") {
          return Object.fromEntries(
            yield* Effect.all(
              Object.entries(input).map(([key, value]) =>
                resolveInput(value).pipe(Effect.map((value) => [key, value])),
              ),
              { concurrency: "unbounded" },
            ),
          );
        }
        return input;
      });

    const resolveOutput = (expr: Output.Expr<any>): Effect.Effect<any> =>
      Effect.gen(function* () {
        if (Output.isResourceExpr(expr)) {
          return yield* resolveResource(expr);
        } else if (Output.isPropExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return upstream?.[expr.identifier];
        } else if (Output.isApplyExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return Output.hasOutputs(upstream) ? expr : expr.f(upstream);
        } else if (Output.isEffectExpr(expr)) {
          const upstream = yield* resolveOutput(expr.expr);
          return Output.hasOutputs(upstream) ? expr : yield* expr.f(upstream);
        } else if (Output.isAllExpr(expr)) {
          return yield* Effect.all(expr.outs.map(resolveOutput), {
            concurrency: "unbounded",
          });
        }
        return yield* Effect.die(new Error("Not implemented yet"));
      });

    // map of resource ID -> its downstream dependencies (resources that depend on it)
    const oldDownstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      oldResources
        .filter((resource) => !!resource)
        .map((resource) => [resource.logicalId, resource.downstream]),
    );

    const newUpstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      resources.map((resource) => [
        resource.LogicalId,
        [
          ...Object.values(Output.upstreamAny(resource.Props)).map(
            (r) => r.LogicalId,
          ),
          // TODO(sam): are we sure we want bindings to be included as upstream dependencies?
          // this kind of breaks their purpose of enabling circularity between resources
          ...Object.values(
            Output.upstreamAny(stack.bindings[resource.LogicalId] ?? []),
          ).map((r) => r.LogicalId),
        ],
      ]),
    );

    const newDownstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      resources.map((resource) => [
        resource.LogicalId,
        Object.entries(newUpstreamDependencies)
          .filter(([_, downstream]) => downstream.includes(resource.LogicalId))
          .map(([id]) => id),
      ]),
    );

    const resourceGraph = Object.fromEntries(
      (yield* Effect.all(
        resources.map(
          Effect.fn(function* (resource) {
            const id = resource.LogicalId;
            const news = yield* resolveInput(resource.Props);
            const newBindings: ResourceBinding[] = yield* resolveInput(
              stack.bindings[id] ?? [],
            );

            const oldState = yield* state.get({
              stack: stackName,
              stage: stage,
              logicalId: id,
            });
            const oldBindings = oldState?.bindings ?? [];
            const provider = yield* resource.Provider;

            const diffBindings = (
              oldBindings: ResourceBinding[],
              newBindings: ResourceBinding[],
            ) => {
              const oldMap = new Map(oldBindings.map((b) => [b.sid, b]));
              const oldKeys = Array.from(oldMap.keys());
              const newMap = new Map(newBindings.map((b) => [b.sid, b]));
              const newKeys = Array.from(newMap.keys());
              const deleted = oldKeys.filter((k) => !newKeys.includes(k));
              const created = newKeys.filter((k) => !oldKeys.includes(k));
              const updated = newKeys.filter(
                (k) =>
                  oldKeys.includes(k) &&
                  arePropsChanged(oldMap.get(k)?.data, newMap.get(k)?.data),
              );
              const noops = newKeys.filter(
                (k) =>
                  oldKeys.includes(k) &&
                  !arePropsChanged(oldMap.get(k)?.data, newMap.get(k)?.data),
              );
              return {
                deleted,
                created,
                updated,
                noops,
              };
            };

            const downstream = newDownstreamDependencies[id] ?? [];

            const Node = <T extends Apply>(
              node: Omit<
                T,
                "provider" | "resource" | "bindings" | "downstream"
              >,
            ) =>
              ({
                ...node,
                provider,
                resource,
                bindings,
                downstream,
              }) as any as T;

            // handle empty and intermediate (non-final) states:
            if (oldState === undefined) {
              return Node<Create>({
                action: "create",
                props: news,
                state: oldState,
              });
            } else if (
              oldState.status === "creating" &&
              oldState.attr === undefined
            ) {
              if (provider.read) {
                const attr = yield* provider
                  .read({
                    id,
                    instanceId: oldState.instanceId,
                    olds: oldState.props,
                    output: oldState.attr,
                  })
                  .pipe(
                    Effect.provide(
                      Layer.succeed(InstanceId, oldState.instanceId),
                    ),
                  );
                if (attr) {
                  return Node<Create>({
                    action: "create",
                    props: news,
                    state: { ...oldState, attr },
                  });
                }
              }
            }

            // TODO(sam): is this correct for all possible states a resource can be in?
            const oldProps = oldState.props;

            const diff = yield* asEffect(
              provider.diff
                ? Effect.provide(
                    provider.diff({
                      id,
                      olds: oldProps,
                      instanceId: oldState.instanceId,
                      output: oldState.attr,
                      news,
                      oldBindings,
                      newBindings: newBindings,
                    }),
                    Layer.succeed(InstanceId, oldState.instanceId),
                  )
                : undefined,
            ).pipe(
              Effect.map(
                (diff) =>
                  diff ??
                  ({
                    action: arePropsChanged(oldProps, news) ? "update" : "noop",
                  } as UpdateDiff | NoopDiff),
              ),
            );

            if (oldState.status === "creating") {
              if (diff.action === "noop") {
                // we're in the creating state and props are un-changed
                // let's just continue where we left off
                return Node<Create>({
                  action: "create",
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // props have changed in a way that is updatable
                // again, just continue with the create
                // TODO(sam): should we maybe try an update instead?
                return Node<Create>({
                  action: "create",
                  props: news,
                  state: oldState,
                });
              } else {
                // props have changed in an incompatible way
                // because it's possible that an un-updatable resource has already been created
                // we must use a replace step to create a new one and delete the potential old one
                return Node<Replace>({
                  action: "replace",
                  props: news,
                  deleteFirst: diff.deleteFirst ?? false,
                  state: oldState,
                });
              }
            } else if (oldState.status === "updating") {
              // we started to update a resource but did not complete
              if (diff.action === "update" || diff.action === "noop") {
                return Node<Update>({
                  action: "update",
                  props: news,
                  state: oldState,
                });
              } else {
                // we started to update a resource but now believe we should replace it
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: diff.deleteFirst ?? false,
                  props: news,
                  // TODO(sam): can Apply handle replacements when the oldState is UpdatingResourceState?
                  // -> or is there we do a provider.read to try and reconcile back to UpdatedResourceState?
                  state: oldState,
                });
              }
            } else if (oldState.status === "replacing") {
              // resource replacement started, but the replacement may or may not have been created
              if (diff.action === "noop") {
                // this is the stable case - noop means just continue with the replacement
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // potential problem here - the props have changed since we tried to replace,
                // but not enough to trigger another replacement. the resource provider should
                // be designed as idempotent to converge to the right state when creating the new resource
                // the newly generated instanceId is intended to assist with this
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              } else {
                // ah shit, so we tried to replace the resource and then crashed
                // now the props have changed again in such a way that the (maybe, maybe not)
                // created resource should also be replaced

                // TODO(sam): what should we do?
                // 1. trigger a deletion of the potentially created resource
                // 2. expect the resource provider to handle it idempotently?
                // -> i don't think this case is fair to put on the resource provider
                //    because if the resource was created, it's in a state that can't be updated
                return yield* Effect.fail(
                  new CannotReplacePartiallyReplacedResource(id),
                );
              }
            } else if (oldState.status === "replaced") {
              // replacement has been created but we're not done cleaning up the old state
              if (diff.action === "noop") {
                // this is the stable case - noop means just continue cleaning up the replacement
                return Node<Replace>({
                  action: "replace",
                  deleteFirst: oldState.deleteFirst,
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "update") {
                // the replacement has been created but now also needs to be updated
                // the resource provider should:
                // 1. Update the newly created replacement resource
                // 2. Then proceed as normal to delete the replaced resources (after all downstream references are updated)
                return Node<Update>({
                  action: "update",
                  props: news,
                  state: oldState,
                });
              } else {
                // the replacement has been created but now it needs to be replaced
                // this is the worst-case scenario because downstream resources
                // could have been been updated to point to the replaced resources
                return yield* Effect.fail(
                  new CannotReplacePartiallyReplacedResource(id),
                );
              }
            } else if (oldState.status === "deleting") {
              if (diff.action === "noop" || diff.action === "update") {
                // we're in a partially deleted state, it is unclear whether it was or was not deleted
                // it should be safe to re-create it with the same instanceId?
                return Node<Create>({
                  action: "create",
                  props: news,
                  state: {
                    ...oldState,
                    status: "creating",
                    props: news,
                  },
                });
              } else {
                return yield* Effect.fail(
                  new CannotReplacePartiallyReplacedResource(id),
                );
              }
            } else if (diff.action === "update") {
              return Node<Update>({
                action: "update",
                props: news,
                state: oldState,
              });
            } else if (diff.action === "replace") {
              return Node<Replace>({
                action: "replace",
                props: news,
                state: oldState,
                deleteFirst: diff?.deleteFirst ?? false,
              });
            } else {
              return Node<NoopUpdate>({
                action: "noop",
                state: oldState,
              });
            }
          }),
        ),
        { concurrency: "unbounded" },
      )).map((update) => [update.resource.LogicalId, update]),
    ) as Plan["resources"];

    const deletions = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list({ stack: stackName, stage: stage })).map(
          Effect.fn(function* (id) {
            if (id in resourceGraph) {
              return;
            }
            const oldState = yield* state.get({
              stack: stackName,
              stage: stage,
              logicalId: id,
            });
            let attr: any = oldState?.attr;
            if (oldState) {
              const resourceType = oldState.resourceType;
              const provider = yield* getProviderByType(resourceType);
              if (oldState.attr === undefined) {
                if (provider.read) {
                  attr = yield* provider
                    .read({
                      id,
                      instanceId: oldState.instanceId,
                      olds: oldState.props as never,
                      output: oldState.attr as never,
                    })
                    .pipe(
                      Effect.provide(
                        Layer.succeed(InstanceId, oldState.instanceId),
                      ),
                    );
                }
              }
              return [
                id,
                {
                  action: "delete",
                  state: { ...oldState, attr },
                  provider: provider,
                  resource: {
                    LogicalId: id,
                    Type: oldState.resourceType,
                    Attributes: attr,
                    Props: oldState.props,
                    Binding: undefined!,
                    Provider: Provider(resourceType),
                    RemovalPolicy: oldState.removalPolicy,
                  } as ResourceLike,
                  // TODO(sam): is it enough to just pass through oldState?
                  downstream: oldDownstreamDependencies[id] ?? [],
                  bindings: oldState.bindings.map((binding) => ({
                    sid: "TODO",
                    action: "delete",
                    args: binding.args,
                  })),
                } satisfies Delete,
              ] as const;
            }
          }),
        ),
        { concurrency: "unbounded" },
      )).filter((v) => !!v),
    );

    for (const [resourceId, deletion] of Object.entries(deletions)) {
      const dependencies = deletion.state.downstream.filter(
        (d) => d in resourceGraph,
      );
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

    return {
      resources: resourceGraph,
      deletions,
      output: stack.output,
    } satisfies Plan<A> as Plan<A>;
  });

export class CannotReplacePartiallyReplacedResource extends Data.TaggedError(
  "CannotReplacePartiallyReplacedResource",
)<{
  message: string;
  logicalId: string;
}> {
  constructor(logicalId: string) {
    super({
      message:
        `Resource '${logicalId}' did not finish being replaced in a previous deployment ` +
        `and is expected to be replaced again in this deployment. ` +
        `You should revert its properties and try again after a successful deployment.`,
      logicalId,
    });
  }
}

export class DeleteResourceHasDownstreamDependencies extends Data.TaggedError(
  "DeleteResourceHasDownstreamDependencies",
)<{
  message: string;
  resourceId: string;
  dependencies: string[];
}> {}

const arePropsChanged = <R extends ResourceLike>(
  oldProps: R["Props"] | undefined,
  newProps: R["Props"],
) => {
  return (
    Output.hasOutputs(newProps) ||
    // TODO(sam): sort keys and deep compare
    JSON.stringify(oldProps ?? {}) !== JSON.stringify(newProps)
  );
};

// TODO(sam): compare props
// oldBinding.props !== newBinding.props;

/**
 * Print a plan in a human-readable format that shows the graph topology.
 */
export const printPlan = (plan: Plan): string => {
  const lines: string[] = [];
  const allNodes = { ...plan.resources, ...plan.deletions };

  // Build reverse mapping: upstream -> downstream
  const upstreamMap: Record<string, string[]> = {};
  for (const [id] of Object.entries(allNodes)) {
    upstreamMap[id] = [];
  }
  for (const [id, node] of Object.entries(allNodes)) {
    if (!node) continue;
    for (const downstreamId of node.state?.downstream ?? []) {
      if (upstreamMap[downstreamId]) {
        upstreamMap[downstreamId].push(id);
      }
    }
  }

  // Action symbols
  const actionSymbol = (action: string) => {
    switch (action) {
      case "create":
        return "+";
      case "update":
        return "~";
      case "delete":
        return "-";
      case "replace":
        return "±";
      case "noop":
        return "=";
      default:
        return "?";
    }
  };

  // Print header
  lines.push(
    "╔════════════════════════════════════════════════════════════════╗",
  );
  lines.push(
    "║                           PLAN                                 ║",
  );
  lines.push(
    "╠════════════════════════════════════════════════════════════════╣",
  );
  lines.push(
    "║ Legend: + create, ~ update, - delete, ± replace, = noop        ║",
  );
  lines.push(
    "╚════════════════════════════════════════════════════════════════╝",
  );
  lines.push("");

  // Print resources section
  lines.push(
    "┌─ Resources ────────────────────────────────────────────────────┐",
  );
  const resourceIds = Object.keys(plan.resources).sort();
  for (const id of resourceIds) {
    const node = plan.resources[id];
    const symbol = actionSymbol(node.action);
    const type = node.resource?.type ?? "unknown";
    const downstream = node.state?.downstream?.length
      ? ` → [${node.state?.downstream.join(", ")}]`
      : "";
    lines.push(`│ [${symbol}] ${id} (${type})${downstream}`);
  }
  if (resourceIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  // Print deletions section
  lines.push(
    "┌─ Deletions ────────────────────────────────────────────────────┐",
  );
  const deletionIds = Object.keys(plan.deletions).sort();
  for (const id of deletionIds) {
    const node = plan.deletions[id]!;
    const type = node.resource?.Type ?? "unknown";
    const downstream = node.state.downstream?.length
      ? ` → [${node.state.downstream.join(", ")}]`
      : "";
    lines.push(`│ [-] ${id} (${type})${downstream}`);
  }
  if (deletionIds.length === 0) {
    lines.push("│ (none)");
  }
  lines.push(
    "└────────────────────────────────────────────────────────────────┘",
  );
  lines.push("");

  return lines.join("\n");
};
