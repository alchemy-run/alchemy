import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import { App } from "./app.ts";
import type { AnyBinding, BindingService } from "./binding.ts";
import {
  type PlanStatusSession,
  CLI,
  type ScopedPlanStatusSession,
} from "./cli/service.ts";
import type { ApplyStatus } from "./event.ts";
import { generateInstanceId, InstanceId } from "./instance-id.ts";
import * as Output from "./output.ts";
import {
  type Apply,
  plan,
  type BindNode,
  type Delete,
  type DerivePlan,
  type IPlan,
  type Providers,
} from "./plan.ts";
import type { Instance } from "./policy.ts";
import type { AnyResource, Resource } from "./resource.ts";
import type { AnyService } from "./service.ts";
import {
  type CreatedResourceState,
  type CreatingResourceState,
  type DeletingResourceState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  type UpdatedResourceState,
  type UpdatingReourceState,
  State,
  StateStoreError,
} from "./state.ts";
import { asEffect } from "./util.ts";
import { getProviderByType } from "./provider.ts";
import { Layer } from "effect";

export type ApplyEffect<
  P extends IPlan,
  Err = never,
  Req = never,
> = Effect.Effect<
  {
    [k in keyof AppliedPlan<P>]: AppliedPlan<P>[k];
  },
  Err,
  Req
>;

export type AppliedPlan<P extends IPlan> = {
  [id in keyof P["resources"]]: P["resources"][id] extends
    | Delete<Resource>
    | undefined
    | never
    ? never
    : Simplify<P["resources"][id]["resource"]["attr"]>;
};

export const apply = <
  const Resources extends (AnyService | AnyResource)[] = never,
>(
  ...resources: Resources
): ApplyEffect<
  DerivePlan<Instance<Resources[number]>>,
  never,
  State | Providers<Instance<Resources[number]>>
  // TODO(sam): don't cast to any
> =>
  plan(...resources).pipe(
    Effect.flatMap((p) => applyPlan(p as any as IPlan)),
  ) as any;

export const applyPlan = <P extends IPlan>(plan: P) =>
  Effect.gen(function* () {
    const cli = yield* CLI;
    const session = yield* cli.startApplySession(plan);

    // 1. expand the graph (create new resources, update existing and create replacements)
    const resources = yield* expandAndPivot(plan, session);
    // TODO(sam): support roll back to previous state if errors occur during expansion
    // -> RISK: some UPDATEs may not be reverisble (i.e. trigger replacements)
    // TODO(sam): should pivot be done separately? E.g shift traffic?

    // 2. delete orphans and replaced resources
    yield* collectGarbage(plan, session);

    yield* session.done();

    if (Object.keys(plan.resources).length === 0) {
      // all resources are deleted, return undefined
      return undefined;
    }
    return resources as {
      [k in keyof AppliedPlan<P>]: AppliedPlan<P>[k];
    };
  });

const expandAndPivot = Effect.fnUntraced(function* (
  plan: IPlan,
  session: PlanStatusSession,
) {
  const state = yield* State;
  const app = yield* App;

  const outputs = {} as Record<string, Effect.Effect<any, any, State>>;
  const resolveUpstream = Effect.fn(function* (resourceId: string) {
    const upstreamNode = plan.resources[resourceId];
    const upstreamAttr = upstreamNode
      ? yield* apply(upstreamNode)
      : yield* Effect.dieMessage(`Resource ${resourceId} not found`);
    return {
      resourceId,
      upstreamAttr,
      upstreamNode,
    };
  });

  const resolveBindingUpstream = Effect.fn(function* ({
    node,
  }: {
    node: BindNode;
    resource: Resource;
  }) {
    const binding = node.binding as AnyBinding & {
      // smuggled property (because it interacts poorly with inference)
      Tag: Context.Tag<never, BindingService>;
    };
    const provider = yield* binding.Tag;
    const resourceId: string = node.binding.capability.resource.id;
    const { upstreamAttr, upstreamNode } = yield* resolveUpstream(resourceId);

    return {
      resourceId,
      upstreamAttr,
      upstreamNode,
      provider,
    };
  });

  const attachBindings = ({
    resource,
    bindings,
    target,
  }: {
    resource: Resource;
    bindings: BindNode[];
    target: {
      id: string;
      props: any;
      attr: any;
    };
  }) =>
    Effect.all(
      bindings.map(
        Effect.fn(function* (node) {
          const { resourceId, upstreamAttr, upstreamNode, provider } =
            yield* resolveBindingUpstream({ node, resource });

          const input = {
            source: {
              id: resourceId,
              attr: upstreamAttr,
              props: upstreamNode.resource.props,
            },
            props: node.binding.props,
            attr: node.attr,
            target,
          } as const;
          if (node.action === "attach") {
            return yield* asEffect(provider.attach(input));
          } else if (node.action === "reattach") {
            // reattach is optional, we fall back to attach if it's not available
            return yield* asEffect(
              (provider.reattach ? provider.reattach : provider.attach)(input),
            );
          } else if (node.action === "detach" && provider.detach) {
            return yield* asEffect(
              provider.detach({
                ...input,
                target,
              }),
            );
          }
          return node.attr;
        }),
      ),
    );

  const postAttachBindings = ({
    bindings,
    bindingOutputs,
    resource,
    target,
  }: {
    bindings: BindNode[];
    bindingOutputs: any[];
    resource: Resource;
    target: {
      id: string;
      props: any;
      attr: any;
    };
  }) =>
    Effect.all(
      bindings.map(
        Effect.fn(function* (node, i) {
          const { resourceId, upstreamAttr, upstreamNode, provider } =
            yield* resolveBindingUpstream({ node, resource });

          const oldBindingOutput = bindingOutputs[i];

          if (
            provider.postattach &&
            (node.action === "attach" || node.action === "reattach")
          ) {
            const bindingOutput = yield* asEffect(
              provider.postattach({
                source: {
                  id: resourceId,
                  attr: upstreamAttr,
                  props: upstreamNode.resource.props,
                },
                props: node.binding.props,
                attr: oldBindingOutput,
                target,
              } as const),
            );
            return {
              ...oldBindingOutput,
              ...bindingOutput,
            };
          }
          return oldBindingOutput;
        }),
      ),
    );

  const apply: (node: Apply) => Effect.Effect<any, never, never> = (node) =>
    Effect.gen(function* () {
      const commit = <State extends ResourceState>(value: State) =>
        state.set({
          stack: app.name,
          stage: app.stage,
          resourceId: node.resource.id,
          value,
        });

      const id = node.resource.id;
      const resource = node.resource;

      const scopedSession = {
        ...session,
        note: (note: string) =>
          session.emit({
            id,
            kind: "annotate",
            message: note,
          }),
      } satisfies ScopedPlanStatusSession;

      return yield* (outputs[id] ??= yield* Effect.cached(
        Effect.gen(function* () {
          const report = (status: ApplyStatus) =>
            session.emit({
              kind: "status-change",
              id,
              type: node.resource.type,
              status,
            });

          if (node.action === "noop") {
            return node.state.attr;
          }

          // resolve upstream dependencies before committing any changes to state
          const upstream = Object.fromEntries(
            yield* Effect.all(
              Object.entries(Output.resolveUpstream(node.props)).map(([id]) =>
                resolveUpstream(id).pipe(
                  Effect.map(({ upstreamAttr }) => [id, upstreamAttr]),
                ),
              ),
            ),
          );

          const instanceId = yield* Effect.gen(function* () {
            if (node.action === "create" && !node.state?.instanceId) {
              const instanceId = yield* generateInstanceId();
              yield* commit<CreatingResourceState>({
                status: "creating",
                instanceId,
                logicalId: id,
                downstream: node.downstream,
                props: node.props,
                providerVersion: node.provider.version ?? 0,
                resourceType: node.resource.type,
                bindings: node.bindings,
              });
              return instanceId;
            } else if (node.action === "replace") {
              if (
                node.state.status === "replaced" ||
                node.state.status === "replacing"
              ) {
                // replace has already begun and we have the new instanceId, do not re-create it
                return node.state.instanceId;
              }
              const instanceId = yield* generateInstanceId();
              yield* commit<ReplacingResourceState>({
                status: "replacing",
                instanceId,
                logicalId: id,
                downstream: node.downstream,
                props: node.props,
                providerVersion: node.provider.version ?? 0,
                resourceType: node.resource.type,
                bindings: node.bindings,
                old: node.state,
                deleteFirst: node.deleteFirst,
              });
              return instanceId;
            } else if (node.state?.instanceId) {
              // we're in a create, update or delete state with a stable instanceId, use it
              return node.state.instanceId;
            }
            // this should never happen
            return yield* Effect.dieMessage(
              `Instance ID not found for resource '${id}' and action is '${node.action}'`,
            );
          });

          const apply = Effect.gen(function* () {
            if (node.action === "create") {
              const news = (yield* Output.evaluate(
                node.props,
                upstream,
              )) as Record<string, any>;

              const checkpoint = (attr: any) =>
                commit<CreatingResourceState>({
                  status: "creating",
                  logicalId: id,
                  instanceId,
                  resourceType: node.resource.type,
                  props: news,
                  attr,
                  providerVersion: node.provider.version ?? 0,
                  bindings: node.bindings,
                  downstream: node.downstream,
                });

              if (!node.state) {
                yield* checkpoint(undefined);
              }

              let attr: any;
              if (
                node.action === "create" &&
                node.provider.precreate &&
                // pre-create is only designed to ensure the resource exists, if we have state.attr, then it already exists and should be skipped
                node.state?.attr === undefined
              ) {
                yield* report("pre-creating");

                // stub the resource prior to resolving upstream resources or bindings if a stub is available
                attr = yield* node.provider.precreate({
                  id,
                  news: node.props,
                  session: scopedSession,
                  instanceId,
                });

                yield* checkpoint(attr);
              }

              yield* report("attaching");

              let bindingOutputs = yield* attachBindings({
                resource,
                bindings: node.bindings,
                target: {
                  id,
                  props: news,
                  attr,
                },
              });

              yield* report("creating");

              attr = yield* node.provider.create({
                id,
                news,
                instanceId,
                bindings: bindingOutputs,
                session: scopedSession,
              });

              yield* checkpoint(attr);

              yield* report("post-attach");
              bindingOutputs = yield* postAttachBindings({
                resource,
                bindings: node.bindings,
                bindingOutputs,
                target: {
                  id,
                  props: news,
                  attr,
                },
              });

              yield* commit<CreatedResourceState>({
                status: "created",
                logicalId: id,
                instanceId,
                resourceType: node.resource.type,
                props: news,
                attr,
                bindings: node.bindings.map((binding, i) => ({
                  ...binding,
                  attr: bindingOutputs[i],
                })),
                providerVersion: node.provider.version ?? 0,
                downstream: node.downstream,
              });

              yield* report("created");

              return attr;
            } else if (node.action === "update") {
              const upstream = Object.fromEntries(
                yield* Effect.all(
                  Object.entries(Output.resolveUpstream(node.props)).map(
                    ([id]) =>
                      resolveUpstream(id).pipe(
                        Effect.map(({ upstreamAttr }) => [id, upstreamAttr]),
                      ),
                  ),
                ),
              );
              const news = (yield* Output.evaluate(
                node.props,
                upstream,
              )) as Record<string, any>;

              const checkpoint = (attr: any) => {
                if (node.state.status === "replaced") {
                  return commit<ReplacedResourceState>({
                    ...node.state,
                    attr,
                    props: news,
                  });
                } else {
                  return commit<UpdatingReourceState>({
                    status: "updating",
                    logicalId: id,
                    instanceId,
                    resourceType: node.resource.type,
                    props: news,
                    attr,
                    providerVersion: node.provider.version ?? 0,
                    bindings: node.bindings,
                    downstream: node.downstream,
                    old:
                      node.state.status === "updating"
                        ? node.state.old
                        : node.state,
                  });
                }
              };

              yield* checkpoint(node.state.attr);

              yield* report("attaching");

              let bindingOutputs = yield* attachBindings({
                resource,
                bindings: node.bindings,
                target: {
                  id,
                  props: news,
                  attr: node.state.attr,
                },
              });

              yield* report("updating");

              const attr = yield* node.provider.update({
                id,
                news,
                instanceId,
                bindings: bindingOutputs,
                session: scopedSession,
                olds:
                  node.state.status === "created" ||
                  node.state.status === "updated" ||
                  node.state.status === "replaced"
                    ? node.state.props
                    : node.state.old.props,
                output: node.state.attr,
              });

              yield* checkpoint(attr);

              yield* report("post-attach");

              bindingOutputs = yield* postAttachBindings({
                resource,
                bindings: node.bindings,
                bindingOutputs,
                target: {
                  id,
                  props: news,
                  attr,
                },
              });

              if (node.state.status === "replaced") {
                yield* commit<ReplacedResourceState>({
                  ...node.state,
                  attr,
                  props: news,
                });
              } else {
                yield* commit<UpdatedResourceState>({
                  status: "updated",
                  logicalId: id,
                  instanceId,
                  resourceType: node.resource.type,
                  props: news,
                  attr,
                  bindings: node.bindings.map((binding, i) => ({
                    ...binding,
                    attr: bindingOutputs[i],
                  })),
                  providerVersion: node.provider.version ?? 0,
                  downstream: node.downstream,
                });
              }

              yield* report("updated");

              return attr;
            } else if (node.action === "replace") {
              if (node.state.status === "replaced") {
                // we've already created the replacement resource, return the output
                return node.state.attr;
              }
              let state: ReplacingResourceState;
              if (node.state.status !== "replacing") {
                yield* commit<ReplacingResourceState>(
                  (state = {
                    status: "replacing",
                    logicalId: id,
                    instanceId,
                    resourceType: node.resource.type,
                    props: node.props,
                    attr: node.state.attr,
                    providerVersion: node.provider.version ?? 0,
                    deleteFirst: node.deleteFirst,
                    old: node.state,
                    downstream: node.downstream,
                  }),
                );
              } else {
                state = node.state;
              }
              const upstream = Object.fromEntries(
                yield* Effect.all(
                  Object.entries(Output.resolveUpstream(node.props)).map(
                    ([id]) =>
                      resolveUpstream(id).pipe(
                        Effect.map(({ upstreamAttr }) => [id, upstreamAttr]),
                      ),
                  ),
                ),
              );
              const news = (yield* Output.evaluate(
                node.props,
                upstream,
              )) as Record<string, any>;

              const checkpoint = <
                S extends ReplacingResourceState | ReplacedResourceState,
              >({
                status,
                attr,
                bindings,
              }: Pick<S, "status" | "attr" | "bindings">) =>
                commit<S>({
                  status,
                  logicalId: id,
                  instanceId,
                  resourceType: node.resource.type,
                  props: news,
                  attr,
                  providerVersion: node.provider.version ?? 0,
                  bindings: bindings ?? node.bindings,
                  downstream: node.downstream,
                  old: state.old,
                  deleteFirst: node.deleteFirst,
                } as S);

              let attr: any;
              if (
                node.provider.precreate &&
                // pre-create is only designed to ensure the resource exists, if we have state.attr, then it already exists and should be skipped
                node.state?.attr === undefined
              ) {
                yield* report("pre-creating");

                // stub the resource prior to resolving upstream resources or bindings if a stub is available
                attr = yield* node.provider.precreate({
                  id,
                  news: node.props,
                  session: scopedSession,
                  instanceId,
                });

                yield* checkpoint({
                  status: "replacing",
                  attr,
                });
              }

              yield* report("attaching");

              let bindingOutputs = yield* attachBindings({
                resource,
                bindings: node.bindings,
                target: {
                  id,
                  props: news,
                  attr,
                },
              });

              yield* report("creating replacement");

              attr = yield* node.provider.create({
                id,
                news,
                instanceId,
                bindings: bindingOutputs,
                session: scopedSession,
              });

              yield* checkpoint({
                status: "replacing",
                attr,
              });

              yield* report("post-attach");

              bindingOutputs = yield* postAttachBindings({
                resource,
                bindings: node.bindings,
                bindingOutputs,
                target: {
                  id,
                  props: news,
                  attr,
                },
              });

              yield* checkpoint<ReplacedResourceState>({
                status: "replaced",
                attr,
                bindings: node.bindings.map((binding, i) => ({
                  ...binding,
                  attr: bindingOutputs[i],
                })),
              });

              yield* report("created");
              return attr;
            }
            // @ts-expect-error
            return yield* Effect.dieMessage(`Unknown action: ${node.action}`);
          });

          // provide the resource-specific context (InstanceId, etc.)
          return yield* apply.pipe(
            Effect.provide(Layer.succeed(InstanceId, instanceId)),
          );
        }),
      ));
    }) as Effect.Effect<any, never, never>;

  return Object.fromEntries(
    yield* Effect.all(
      Object.entries(plan.resources).map(
        Effect.fn(function* ([id, node]) {
          return [id, yield* apply(node)];
        }),
      ),
    ),
  );
});

const collectGarbage = Effect.fnUntraced(function* (
  plan: IPlan,
  session: PlanStatusSession,
) {
  const state = yield* State;
  const app = yield* App;

  const deletions: {
    [logicalId in string]: Effect.Effect<void, StateStoreError, never>;
  } = {};

  // delete all replaced resources
  const replacedResources = yield* state.getReplacedResources({
    stack: app.name,
    stage: app.stage,
  });

  const deletionGraph = {
    ...plan.deletions,
    ...Object.fromEntries(
      replacedResources.map((replaced) => [replaced.logicalId, replaced]),
    ),
  };

  const deleteResource: (
    node: Delete<Resource> | ReplacedResourceState,
  ) => Effect.Effect<void, StateStoreError, never> = Effect.fnUntraced(
    function* (node: Delete<Resource> | ReplacedResourceState) {
      const isDeleteNode = (
        node: Delete<Resource> | ReplacedResourceState,
      ): node is Delete<Resource> => "action" in node;

      const {
        logicalId,
        resourceType,
        instanceId,
        downstream,
        props,
        attr,
        provider,
      } = isDeleteNode(node)
        ? {
            logicalId: node.resource.id,
            resourceType: node.resource.type,
            instanceId: node.state.instanceId,
            downstream: node.downstream,
            props: node.state.props,
            attr: node.state.attr,
            provider: node.provider,
          }
        : {
            logicalId: node.logicalId,
            resourceType: node.old.resourceType,
            instanceId: node.old.instanceId,
            downstream: node.old.downstream,
            props: node.old.props,
            attr: node.old.attr,
            provider: yield* getProviderByType(node.old.resourceType),
          };

      const commit = <State extends ResourceState>(value: State) =>
        state.set({
          stack: app.name,
          stage: app.stage,
          resourceId: logicalId,
          value,
        });

      const report = (status: ApplyStatus) =>
        session.emit({
          kind: "status-change",
          id: logicalId,
          type: resourceType,
          status,
        });

      const scopedSession = {
        ...session,
        note: (note: string) =>
          session.emit({
            id: logicalId,
            kind: "annotate",
            message: note,
          }),
      } satisfies ScopedPlanStatusSession;

      return yield* (deletions[logicalId] ??= yield* Effect.cached(
        Effect.gen(function* () {
          yield* Effect.all(
            downstream.map((dep) =>
              dep in deletionGraph
                ? deleteResource(deletionGraph[dep] as Delete<Resource>)
                : Effect.void,
            ),
          );

          yield* report("deleting");

          if (isDeleteNode(node)) {
            yield* commit<DeletingResourceState>({
              status: "deleting",
              logicalId,
              instanceId,
              resourceType,
              props,
              attr,
              downstream,
              providerVersion: provider.version ?? 0,
              bindings: node.bindings,
            });
          }

          yield* provider.delete({
            id: logicalId,
            instanceId,
            olds: props as never,
            output: attr,
            session: scopedSession,
            bindings: [],
          });

          if (isDeleteNode(node)) {
            // TODO(sam): should we commit a tombstone instead? and then clean up tombstones after all deletions are complete?
            yield* state.delete({
              stack: app.name,
              stage: app.stage,
              resourceId: logicalId,
            });
            yield* report("deleted");
          } else {
            yield* commit<CreatedResourceState>({
              status: "created",
              logicalId,
              instanceId,
              resourceType,
              props: node.props,
              attr: node.attr,
              providerVersion: provider.version ?? 0,
              downstream: node.downstream,
              bindings: node.bindings,
            });
            yield* report("replaced");
          }
        }).pipe(Effect.provide(Layer.succeed(InstanceId, instanceId))),
      ));
    },
  );

  yield* Effect.all(
    Object.values(deletionGraph)
      .filter((node) => node !== undefined)
      .map(deleteResource),
  );
});
