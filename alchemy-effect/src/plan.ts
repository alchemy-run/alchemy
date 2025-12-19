import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { omit } from "effect/Struct";
import { App } from "./app.ts";
import type {
  AnyBinding,
  BindingDiffProps,
  BindingService,
} from "./binding.ts";
import type { Capability } from "./capability.ts";
import type { Diff, NoopDiff, UpdateDiff } from "./diff.ts";
import { InstanceId } from "./instance-id.ts";
import * as Output from "./output.ts";
import type { Instance } from "./policy.ts";
import type { Provider } from "./provider.ts";
import { getProviderByType, type ProviderService } from "./provider.ts";
import type { AnyResource, Resource, ResourceTags } from "./resource.ts";
import { isService, type IService, type Service } from "./service.ts";
import {
  State,
  StateStoreError,
  type CreatedResourceState,
  type CreatingResourceState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type UpdatedResourceState,
  type UpdatingReourceState,
} from "./state.ts";
import { asEffect } from "./util.ts";

export type PlanError = never;

export const isBindNode = (node: any): node is BindNode => {
  return (
    node &&
    typeof node === "object" &&
    (node.action === "attach" ||
      node.action === "detach" ||
      node.action === "noop")
  );
};

/**
 * A node in the plan that represents a binding operation acting on a resource.
 */
export type BindNode<B extends AnyBinding = AnyBinding> =
  | Attach<B>
  | Reattach<B>
  | Detach<B>
  | NoopBind<B>;

export type Attach<B extends AnyBinding = AnyBinding> = {
  action: "attach";
  binding: B;
  olds: BindNode | undefined;
  attr: B["attr"] | undefined;
};

export type Reattach<B extends AnyBinding = AnyBinding> = {
  action: "reattach";
  binding: B;
  olds: BindNode;
  attr: B["attr"];
};

export type Detach<B extends AnyBinding = AnyBinding> = {
  action: "detach";
  binding: B;
  attr: B["attr"] | undefined;
};

export type NoopBind<B extends AnyBinding = AnyBinding> = {
  action: "noop";
  binding: B;
  attr: B["attr"];
};

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
export type CRUD<R extends Resource = AnyResource> =
  | Create<R>
  | Update<R>
  | Delete<R>
  | Replace<R>
  | NoopUpdate<R>;

export type Apply<R extends Resource = AnyResource> =
  | Create<R>
  | Update<R>
  | Replace<R>
  | NoopUpdate<R>;

export interface BaseNode<R extends Resource = AnyResource> {
  resource: R;
  provider: ProviderService<R>;
  bindings: BindNode[];
  downstream: string[];
}

export interface Create<R extends Resource = AnyResource> extends BaseNode<R> {
  action: "create";
  props: any;
  state: CreatingResourceState | undefined;
}

export interface Update<R extends Resource = AnyResource> extends BaseNode<R> {
  action: "update";
  props: any;
  state:
    | CreatedResourceState
    | UpdatedResourceState
    | UpdatingReourceState
    // the props can change after creating the replacement resource,
    // so Apply needs to handle updates and then continue with cleaning up the replaced graph
    | ReplacedResourceState;
}

export interface Delete<R extends Resource = AnyResource> extends BaseNode<R> {
  action: "delete";
  // a resource can be deleted no matter what state it's in
  state: ResourceState;
}

export interface NoopUpdate<
  R extends Resource = AnyResource,
> extends BaseNode<R> {
  action: "noop";
  state: CreatedResourceState | UpdatedResourceState;
}

export interface Replace<R extends Resource = AnyResource> extends BaseNode<R> {
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

export type ResourceGraph<Resources extends Service | Resource> = ToGraph<
  TraverseResources<Resources>
>;

export type TraverseResources<Resources extends Service | Resource> =
  | Resources
  | BoundResources<Resources>
  | TransitiveResources<Resources>;

type ToGraph<Resources extends Service | Resource> = {
  [ID in Resources["id"]]: Apply<Extract<Resources, { id: ID }>>;
};

export type BoundResources<Resources extends Service | Resource> = NeverUnknown<
  Extract<
    Resources,
    IService
  >["props"]["bindings"]["capabilities"][number]["resource"]
>;

// finds transitive dependencies at most two levels deep
// TODO(sam): figure out an efficient way to do arbitrary depth
export type TransitiveResources<
  Resources extends Service | Resource,
  Found extends Service | Resource = never,
> = Extract<
  | Found
  | {
      [prop in keyof Resources["props"]]: IsAny<
        Resources["props"][prop]
      > extends true
        ? Found
        : Resources["props"][prop] extends { kind: "alchemy/Policy" }
          ? Found
          : Resources["props"][prop] extends Output.Output<any, infer Src, any>
            ? Src extends Found
              ? Found
              : TransitiveResources<Src, Src | Found>
            : {
                [p in keyof Resources["props"][prop]]: IsAny<
                  Resources["props"][prop][p]
                > extends true
                  ? Found
                  : Resources["props"][prop][p] extends Output.Output<
                        any,
                        infer Src,
                        any
                      >
                    ? Src extends Found
                      ? Found
                      : string extends Src["id"]
                        ? Found
                        : TransitiveResources<Src, Src | Found>
                    : Found;
              }[keyof Resources["props"][prop]];
    }[keyof Resources["props"]],
  Service | Resource
>;

export type Providers<Resources extends Service | Resource> =
  | ResourceProviders<Resources>
  | BindingTags<Resources>;

export type ResourceProviders<Res extends Service | Resource> = Res extends any
  ? Provider<Extract<Res["base"], Service | Resource>>
  : never;

export type BindingTags<Resources extends Service | Resource> = NeverUnknown<
  Extract<Resources, Service>["props"]["bindings"]["tags"][number]
>;

type NeverUnknown<T> = unknown extends T ? never : T;

type IsAny<T> = 0 extends 1 & T ? true : false;

export type DerivePlan<Resources extends Service | Resource> = {
  resources: {
    [ID in keyof ResourceGraph<Resources>]: ResourceGraph<Resources>[ID];
  };
  deletions: {
    [ID in string]: Delete<AnyResource>;
  };
};

export type IPlan = {
  resources: {
    [id in string]: Apply<any>;
  };
  deletions: {
    [id in string]?: Delete<Resource>;
  };
};

export type Plan<Resources extends Service | Resource> = Effect.Effect<
  DerivePlan<Resources>,
  | CannotReplacePartiallyReplacedResource
  | DeleteResourceHasDownstreamDependencies,
  Providers<Resources> | State
>;

export const plan = <const Resources extends (Service | Resource)[]>(
  ..._resources: Resources
): Plan<Instance<Resources[number]>> =>
  Effect.gen(function* () {
    const state = yield* State;

    const findResources = (
      resource: Service | Resource,
      visited: Set<string>,
    ): (Service | Resource)[] => {
      if (visited.has(resource.id)) {
        return [];
      }
      visited.add(resource.id);
      const upstream = Object.values(Output.upstreamAny(resource.props)) as (
        | Service
        | Resource
      )[];
      return [
        resource,
        ...upstream,
        ...upstream.flatMap((r) => findResources(r, visited)),
      ];
    };
    const resources = _resources
      .flatMap((r) => findResources(r, new Set()))
      .filter((r, i, arr) => arr.findIndex((r2) => r2.id === r.id) === i);

    // TODO(sam): rename terminology to Stack
    const app = yield* App;

    const resourceIds = yield* state.list({
      stack: app.name,
      stage: app.stage,
    });
    const oldResources = yield* Effect.all(
      resourceIds.map((id) =>
        state.get({ stack: app.name, stage: app.stage, resourceId: id }),
      ),
      { concurrency: "unbounded" },
    );

    type ResolveEffect<T> = Effect.Effect<T, ResolveErr, ResolveReq>;
    type ResolveErr = StateStoreError;
    type ResolveReq =
      | Context.TagClass<
          Provider<Resource<string, string, any, any>>,
          string,
          ProviderService<Resource<string, string, any, any>>
        >
      | State;

    const resolvedResources: Record<
      string,
      ResolveEffect<
        | {
            [attr in string]: any;
          }
        | undefined
      >
    > = {};

    const resolveResource = (
      resourceExpr: Output.ResourceExpr<any, any, any>,
    ) =>
      Effect.gen(function* () {
        return yield* (resolvedResources[resourceExpr.src.id] ??=
          yield* Effect.cached(
            Effect.gen(function* () {
              const resource = resourceExpr.src as Resource & {
                provider: ResourceTags<Resource<string, string, any, any>>;
              };
              const provider = yield* resource.provider.tag;
              const props = yield* resolveInput(resource.props);
              const oldState = yield* state.get({
                stack: app.name,
                stage: app.stage,
                resourceId: resource.id,
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

              const diff = yield* provider.diff
                ? provider
                    .diff({
                      id: resource.id,
                      olds: oldProps,
                      instanceId: oldState.instanceId,
                      news: props,
                      output: oldState.attr,
                    })
                    .pipe(
                      Effect.provide(
                        Layer.succeed(InstanceId, oldState.instanceId),
                      ),
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

    const resolveInput = (input: any): ResolveEffect<any> =>
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

    const resolveOutput = (expr: Output.Expr<any>): ResolveEffect<any> =>
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
        resource.id,
        [
          ...Object.values(Output.upstreamAny(resource.props)).map((r) => r.id),
          ...(isService(resource)
            ? resource.props.bindings.capabilities.map((cap) => cap.resource.id)
            : []),
        ],
      ]),
    );

    const newDownstreamDependencies: {
      [resourceId: string]: string[];
    } = Object.fromEntries(
      resources.map((resource) => [
        resource.id,
        Object.entries(newUpstreamDependencies)
          .filter(([_, downstream]) => downstream.includes(resource.id))
          .map(([id]) => id),
      ]),
    );

    const resourceGraph = Object.fromEntries(
      (yield* Effect.all(
        resources
          .flatMap((resource) => [
            ...(isService(resource)
              ? resource.props.bindings.capabilities.map(
                  (cap: Capability) => cap.resource as Resource,
                )
              : []),
            ...Object.values(Output.upstreamAny(resource.props)),
            resource,
          ])
          .filter(
            (node, i, arr) => arr.findIndex((n) => n.id === node.id) === i,
          )
          .map(
            Effect.fn(function* (node) {
              const id = node.id;
              const resource = node as Resource & {
                provider: ResourceTags<Resource<string, string, any, any>>;
              };
              const news = yield* resolveInput(resource.props);

              const oldState = yield* state.get({
                stack: app.name,
                stage: app.stage,
                resourceId: id,
              });
              const provider = yield* resource.provider.tag;

              const downstream = newDownstreamDependencies[id] ?? [];

              const bindings = isService(node)
                ? yield* diffBindings({
                    oldState,
                    bindings: (
                      node.props.bindings as unknown as {
                        bindings: AnyBinding[];
                      }
                    ).bindings,
                    target: {
                      id: node.id,
                      props: node.props,
                      // TODO(sam): pick the right ones based on old status
                      oldAttr: oldState?.attr,
                      oldProps: oldState?.props,
                    },
                  })
                : []; // TODO(sam): return undefined instead of empty array

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
                return Node<Create<Resource>>({
                  action: "create",
                  props: news,
                  state: oldState,
                });
              } else if (
                oldState.status === "creating" &&
                oldState.attr === undefined
              ) {
                if (provider.read) {
                  const attr = yield* provider.read({
                    id,
                    instanceId: oldState.instanceId,
                    olds: oldState.props,
                    output: oldState.attr,
                    bindings,
                  });
                  if (attr) {
                    return Node<Create<Resource>>({
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
                  ? provider
                      .diff({
                        id,
                        olds: oldProps,
                        instanceId: oldState.instanceId,
                        output: oldState.attr,
                        news,
                      })
                      .pipe(
                        Effect.provide(
                          Layer.succeed(InstanceId, oldState.instanceId),
                        ),
                      )
                  : undefined,
              ).pipe(
                Effect.map(
                  (diff) =>
                    diff ??
                    ({
                      action: arePropsChanged(oldProps, news)
                        ? "update"
                        : "noop",
                    } as UpdateDiff | NoopDiff),
                ),
              );

              if (oldState.status === "creating") {
                if (diff.action === "noop") {
                  // we're in the creating state and props are un-changed
                  // let's just continue where we left off
                  return Node<Create<Resource>>({
                    action: "create",
                    props: news,
                    state: oldState,
                  });
                } else if (diff.action === "update") {
                  // props have changed in a way that is updatable
                  // again, just continue with the create
                  // TODO(sam): should we maybe try an update instead?
                  return Node<Create<Resource>>({
                    action: "create",
                    props: news,
                    state: oldState,
                  });
                } else {
                  // props have changed in an incompatible way
                  // because it's possible that an un-updatable resource has already been created
                  // we must use a replace step to create a new one and delete the potential old one
                  return Node<Replace<Resource>>({
                    action: "replace",
                    props: news,
                    deleteFirst: diff.deleteFirst ?? false,
                    state: oldState,
                  });
                }
              } else if (oldState.status === "updating") {
                // we started to update a resource but did not complete
                if (diff.action === "update" || diff.action === "noop") {
                  return Node<Update<Resource>>({
                    action: "update",
                    props: news,
                    state: oldState,
                  });
                } else {
                  // we started to update a resource but now believe we should replace it
                  return Node<Replace<Resource>>({
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
                  return Node<Replace<Resource>>({
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
                  return Node<Replace<Resource>>({
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
                  return Node<Replace<Resource>>({
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
                  return Node<Update<Resource>>({
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
                  return Node<Create<Resource>>({
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
                return Node<Update<Resource>>({
                  action: "update",
                  props: news,
                  state: oldState,
                });
              } else if (diff.action === "replace") {
                return Node<Replace<Resource>>({
                  action: "replace",
                  props: news,
                  state: oldState,
                  deleteFirst: diff?.deleteFirst ?? false,
                });
              } else {
                return Node<NoopUpdate<Resource>>({
                  action: "noop",
                  state: oldState,
                });
              }
            }),
          ),
        { concurrency: "unbounded" },
      )).map((update) => [update.resource.id, update]),
    ) as IPlan["resources"];

    const deletions = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list({ stack: app.name, stage: app.stage })).map(
          Effect.fn(function* (id) {
            if (id in resourceGraph) {
              return;
            }
            const oldState = yield* state.get({
              stack: app.name,
              stage: app.stage,
              resourceId: id,
            });
            let attr: any = oldState?.attr;
            if (oldState) {
              const provider = yield* getProviderByType(oldState.resourceType);
              if (oldState.attr === undefined) {
                if (provider.read) {
                  attr = yield* provider
                    .read({
                      id,
                      instanceId: oldState.instanceId,
                      olds: oldState.props as never,
                      output: oldState.attr as never,
                      bindings: oldState.bindings ?? [],
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
                  // // TODO(sam): Support Detach Bindings
                  bindings: [],
                  provider,
                  resource: {
                    id: id,
                    type: oldState.resourceType,
                    attr,
                    props: oldState.props,
                  } as Resource,
                  // TODO(sam): is it enough to just pass through oldState?
                  downstream: oldDownstreamDependencies[id] ?? [],
                } satisfies Delete<Resource>,
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
    } satisfies IPlan as IPlan;
  }) as any;

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

const arePropsChanged = <R extends Resource>(
  oldProps: R["props"] | undefined,
  newProps: R["props"],
) => {
  return (
    Output.hasOutputs(newProps) ||
    JSON.stringify(omit((oldProps ?? {}) as any, "bindings")) !==
      JSON.stringify(omit((newProps ?? {}) as any, "bindings"))
  );
};

const diffBindings = Effect.fn(function* ({
  oldState,
  bindings,
  target,
}: {
  oldState: ResourceState | undefined;
  bindings: AnyBinding[];
  target: BindingDiffProps["target"];
}) {
  // const actions: BindNode[] = [];
  const oldBindings = oldState?.bindings;
  // const oldSids = new Set(
  //   oldBindings?.map(({ binding }) => binding.capability.sid),
  // );

  const diffBinding: (
    binding: AnyBinding,
  ) => Effect.Effect<BindNode, StateStoreError, State> = Effect.fn(
    function* (binding) {
      const cap = binding.capability;
      const sid = cap.sid ?? `${cap.action}:${cap.resource.ID}`;
      // Find potential oldBinding for this sid
      const oldBinding = oldBindings?.find(
        ({ binding }) => binding.capability.sid === sid,
      );
      if (!oldBinding) {
        return {
          action: "attach",
          binding,
          attr: undefined,
          olds: undefined,
        } satisfies Attach<AnyBinding>;
      }

      const diff = yield* isBindingDiff({
        target,
        oldBinding,
        newBinding: binding,
      });
      // if (diff === false) {
      // } else if (diff === true) {
      //   return {
      //     action: "attach",
      //     binding,
      //     olds: oldBinding,
      //   } satisfies Attach<AnyBinding>;
      // }
      if (diff.action === "replace") {
        return yield* Effect.die(
          new Error("Replace binding not yet supported"),
        );
        // TODO(sam): implement support for replacing bindings
        // return {
        //   action: "replace",
        //   binding,
        //   olds: oldBinding,
        // };
      } else if (diff?.action === "update") {
        return {
          action: "reattach",
          binding,
          olds: oldBinding,
          attr: oldBinding.attr,
        } satisfies Reattach<AnyBinding>;
      }
      return {
        action: "noop",
        binding,
        attr: oldBinding.attr,
      } satisfies NoopBind<AnyBinding>;
    },
  );

  return (yield* Effect.all(bindings.map(diffBinding), {
    concurrency: "unbounded",
  })).filter((action): action is BindNode => action !== null);
});

const isBindingDiff = Effect.fn(function* ({
  target,
  oldBinding: { binding: oldBinding },
  newBinding,
}: {
  // TODO(sam): support binding to other Resources
  target: BindingDiffProps["target"];
  oldBinding: BindNode;
  newBinding: AnyBinding;
}) {
  const oldCap = oldBinding.capability;
  const newCap = newBinding.capability;
  if (
    // if the binding provider has changed
    oldBinding.tag !== newBinding.tag ||
    // if it points to a totally different resource, we should replace
    oldCap?.resource?.id !== newCap?.resource?.id ||
    // if it is a different action
    oldCap.action !== newCap.action
  ) {
    // then we must replace (we need to detach and attach with different bindings or to different resources)
    return {
      action: "replace",
    } satisfies Diff;
  }

  const binding = newBinding as AnyBinding & {
    // smuggled property (because it interacts poorly with inference)
    Tag: Context.Tag<never, BindingService>;
  };
  const provider = yield* binding.Tag;
  if (provider.diff) {
    const state = yield* State;
    const oldState = yield* state.get(oldCap.resource.id);
    if (oldState) {
      const diff = yield* provider
        .diff({
          source: {
            id: oldCap.resource.id,
            props: newCap.resource.props,
            oldProps: oldState?.props,
            oldAttr: oldState?.attr,
          },
          props: newBinding.props,
          attr: oldBinding.attr,
          target,
        })
        .pipe(Effect.provide(Layer.succeed(InstanceId, oldState.instanceId)));

      if (diff?.action === "update" || diff?.action === "replace") {
        return diff;
      }
    }
  }
  return {
    action:
      oldBinding.capability.action !== newBinding.capability.action ||
      oldBinding.capability?.resource?.id !==
        newBinding.capability?.resource?.id
        ? "update"
        : "noop",
  } as const;
});
// TODO(sam): compare props
// oldBinding.props !== newBinding.props;

/**
 * Print a plan in a human-readable format that shows the graph topology.
 */
export const printPlan = (plan: IPlan): string => {
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
    const type = node.resource?.type ?? "unknown";
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
