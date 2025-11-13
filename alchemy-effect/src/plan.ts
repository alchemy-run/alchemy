import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { omit } from "effect/Struct";
import type {
  AnyBinding,
  BindingDiffProps,
  BindingService,
} from "./binding.ts";
import type { Capability } from "./capability.ts";
import type { Phase } from "./phase.ts";
import type { Instance } from "./policy.ts";
import { type Diff, type ProviderService } from "./provider.ts";
import type { Resource, ResourceTags } from "./resource.ts";
import { isService, type IService, type Service } from "./service.ts";
import { State, StateStoreError, type ResourceState } from "./state.ts";

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
export type CRUD<R extends Resource = Resource> =
  | Create<R>
  | Update<R>
  | Delete<R>
  | Replace<R>
  | NoopUpdate<R>;

export type Apply<R extends Resource = Resource> =
  | Create<R>
  | Update<R>
  | Replace<R>
  | NoopUpdate<R>;

const Node = <T extends Apply>(node: T) => ({
  ...node,
  toString(): string {
    return `${this.action.charAt(0).toUpperCase()}${this.action.slice(1)}(${this.resource})`;
  },
  [Symbol.toStringTag]() {
    return this.toString();
  },
});

export type Create<R extends Resource> = {
  action: "create";
  resource: R;
  news: any;
  provider: ProviderService;
  attributes: R["attr"];
  bindings: BindNode[];
};

export type Update<R extends Resource> = {
  action: "update";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: ProviderService;
  attributes: R["attr"];
  bindings: BindNode[];
};

export type Delete<R extends Resource> = {
  action: "delete";
  resource: R;
  olds: any;
  output: any;
  provider: ProviderService;
  bindings: BindNode[];
  attributes: R["attr"];
  downstream: string[];
};

export type NoopUpdate<R extends Resource> = {
  action: "noop";
  resource: R;
  attributes: R["attr"];
  bindings: BindNode[];
};

export type Replace<R extends Resource> = {
  action: "replace";
  resource: R;
  olds: any;
  news: any;
  output: any;
  provider: ProviderService;
  bindings: BindNode[];
  attributes: R["attr"];
  deleteFirst?: boolean;
};

export type Plan = {
  phase: Phase;
  resources: {
    [id in string]: CRUD;
  };
  deletions: {
    [id in string]?: Delete<Resource>;
  };
};

export const plan = <
  const Phase extends "update" | "destroy",
  const Resources extends (Service | Resource)[],
>({
  phase,
  resources,
}: {
  phase: Phase;
  resources: Resources;
}) => {
  type Services = Extract<Resources[number], IService>[];
  type ServiceIDs = Services[number]["id"];
  type ServiceHosts = {
    [ID in ServiceIDs]: Extract<Services[number], Service<Extract<ID, string>>>;
  };
  type UpstreamTags = {
    [ID in ServiceIDs]: ServiceHosts[ID]["props"]["bindings"]["tags"][number];
  }[ServiceIDs];
  type UpstreamResources = {
    [ID in ServiceIDs]: Extract<
      ServiceHosts[ID]["props"]["bindings"]["capabilities"][number]["resource"],
      Resource
    >;
  }[ServiceIDs];
  type ExplicitResources = Resources[number];
  type ResourceGraph = {
    [ID in ServiceIDs]: Apply<Extract<Instance<ServiceHosts[ID]>, Resource>>;
  } & {
    [ID in UpstreamResources["id"]]: Apply<
      Extract<UpstreamResources, { id: ID }>
    >;
  } & {
    [ID in ExplicitResources["id"]]: Apply<
      Extract<ExplicitResources, { id: ID }>
    >;
  };

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
          bindings: BindNode[];
        } => !!resource?.bindings,
      )
      .flatMap((resource) =>
        resource.bindings.flatMap(({ binding }) => [
          [binding.capability.resource.id, binding.capability.resource],
        ]),
      )
      .reduce(
        (acc, [id, resourceId]) => ({
          ...acc,
          [id]: [...(acc[id] ?? []), resourceId],
        }),
        {} as Record<string, string[]>,
      );

    const resourceGraph =
      phase === "update"
        ? (Object.fromEntries(
            (yield* Effect.all(
              resources
                .flatMap((resource) => [
                  ...(isService(resource)
                    ? resource.props.bindings.capabilities.map(
                        (cap: Capability) => cap.resource as Resource,
                      )
                    : []),
                  resource,
                ])
                .filter(
                  (node, i, arr) =>
                    arr.findIndex((n) => n.id === node.id) === i,
                )
                .map(
                  Effect.fn(function* (node) {
                    const id = node.id;
                    const resource = node as Resource & {
                      provider: ResourceTags<Resource>;
                    };
                    const news = resource.props;

                    const oldState = yield* state.get(id);
                    const provider = yield* resource.provider.tag;

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
                            oldAttr: oldState?.output,
                            oldProps: oldState?.props,
                          },
                        })
                      : []; // TODO(sam): return undefined instead of empty array

                    if (
                      oldState === undefined ||
                      oldState.status === "creating"
                    ) {
                      return Node<Create<Resource>>({
                        action: "create",
                        news,
                        provider,
                        resource,
                        bindings,
                        // phantom
                        attributes: undefined!,
                      });
                    }

                    const diff = provider.diff
                      ? yield* provider.diff({
                          id,
                          olds: oldState.props,
                          news,
                          output: oldState.output,
                        })
                      : undefined;

                    if (!diff && arePropsChanged(oldState, resource.props)) {
                      return Node<Update<Resource>>({
                        action: "update",
                        olds: oldState.props,
                        news,
                        output: oldState.output,
                        provider,
                        resource,
                        bindings,
                        // phantom
                        attributes: undefined!,
                      });
                    } else if (diff?.action === "replace") {
                      return Node<Replace<Resource>>({
                        action: "replace",
                        olds: oldState.props,
                        news,
                        output: oldState.output,
                        provider,
                        resource,
                        bindings,
                        // phantom
                        attributes: undefined!,
                      });
                    } else if (diff?.action === "update") {
                      return Node<Update<Resource>>({
                        action: "update",
                        olds: oldState.props,
                        news,
                        output: oldState.output,
                        provider,
                        resource,
                        bindings,
                        // phantom
                        attributes: undefined!,
                      });
                    } else {
                      return Node<NoopUpdate<Resource>>({
                        action: "noop",
                        resource,
                        bindings,
                        // phantom
                        attributes: undefined!,
                      });
                    }
                  }),
                ),
            )).map((update) => [update.resource.id, update]),
          ) as Plan["resources"])
        : ({} as Plan["resources"]);

    const deletions = Object.fromEntries(
      (yield* Effect.all(
        (yield* state.list()).map(
          Effect.fn(function* (id) {
            if (id in resourceGraph) {
              return;
            }
            const oldState = yield* state.get(id);
            const context = yield* Effect.context<never>();
            if (oldState) {
              const provider: ProviderService = context.unsafeMap.get(
                oldState?.type,
              );
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
                    id: id,
                    parent: undefined,
                    type: oldState.type,
                    attr: oldState.output,
                    props: oldState.props,
                  } as Resource,
                  downstream: downstream[id] ?? [],
                } satisfies Delete<Resource>,
              ] as const;
            }
          }),
        ),
      )).filter((v) => !!v),
    );

    for (const [resourceId, deletion] of Object.entries(deletions)) {
      const dependencies = deletion.downstream.filter(
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
      phase,
      resources: resourceGraph,
      deletions,
    } satisfies Plan as Plan;
  }) as Effect.Effect<
    {
      phase: Phase;
      resources: {
        [ID in keyof ResourceGraph]: ResourceGraph[ID];
      };
      deletions: {
        [id in Exclude<string, keyof ResourceGraph>]?: Delete<Resource>;
      };
    },
    never,
    UpstreamTags | State
  >;
};

class DeleteResourceHasDownstreamDependencies extends Data.TaggedError(
  "DeleteResourceHasDownstreamDependencies",
)<{
  message: string;
  resourceId: string;
  dependencies: string[];
}> {}

const arePropsChanged = <R extends Resource>(
  oldState: ResourceState | undefined,
  newProps: R["props"],
) => {
  return (
    JSON.stringify(omit(oldState?.props ?? {}, "bindings")) !==
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
  const oldSids = new Set(
    oldBindings?.map(({ binding }) => binding.capability.sid),
  );

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

  return (yield* Effect.all(bindings.map(diffBinding))).filter(
    (action): action is BindNode => action !== null,
  );
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
    const diff = yield* provider.diff({
      source: {
        id: oldCap.resource.id,
        props: newCap.resource.props,
        oldProps: oldState?.props,
        oldAttr: oldState?.output,
      },
      props: newBinding.props,
      attr: oldBinding.attr,
      target,
    });

    if (diff?.action === "update" || diff?.action === "replace") {
      return diff;
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
