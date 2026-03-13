import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Simplify } from "effect/Types";
import {
  type PlanStatusSession,
  type ScopedPlanStatusSession,
  Cli,
} from "./Cli/Cli.ts";
import type { ApplyStatus } from "./Cli/Event.ts";
import { havePropsChanged } from "./Diff.ts";
import { toFqn } from "./FQN.ts";
import type { Input } from "./Input.ts";
import { generateInstanceId, InstanceId } from "./InstanceId.ts";
import * as Output from "./Output.ts";
import {
  type Apply,
  type Create,
  type Delete,
  type Plan,
  type Replace,
  type Update,
} from "./Plan.ts";
import { getProviderByType } from "./Provider.ts";
import type { ResourceBinding } from "./Resource.ts";
import { Stack } from "./Stack.ts";
import { Stage } from "./Stage.ts";
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
} from "./State/index.ts";

export type ApplyEffect<
  P extends Plan,
  Err = never,
  Req = never,
> = Effect.Effect<
  {
    [k in keyof AppliedPlan<P>]: AppliedPlan<P>[k];
  },
  Err,
  Req
>;

export type AppliedPlan<P extends Plan> = {
  [id in keyof P["resources"]]: P["resources"][id] extends
    | Delete
    | undefined
    | never
    ? never
    : Simplify<P["resources"][id]["resource"]["attr"]>;
};

export const apply = <P extends Plan>(
  plan: P,
): Effect.Effect<
  Input.Resolve<P["output"]>,
  Output.InvalidReferenceError | Output.MissingSourceError | StateStoreError,
  Cli | State | Stack | Stage
> =>
  Effect.gen(function* () {
    const cli = yield* Cli;
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

    return yield* Output.evaluate(plan.output, resources);
  });

const expandAndPivot = Effect.fnUntraced(function* (
  plan: Plan,
  session: PlanStatusSession,
) {
  const state = yield* State;
  const stack = yield* Stack;
  const stackName = stack.name;
  const stage = yield* Stage;
  const makeDeferred = Effect.all(
    Object.keys(plan.resources).map((id) =>
      Effect.map(Deferred.make<any>(), (output) => [id, output]),
    ),
  ).pipe(
    Effect.map(
      (e) => Object.fromEntries(e) as Record<string, Deferred.Deferred<any>>,
    ),
  );

  const precreateOutputs = yield* makeDeferred;
  const postcreateOutputs = yield* makeDeferred;
  const outputs = {} as Record<string, Effect.Effect<any, any, State>>;

  const resolveUpstream = Effect.fn(function* (
    resourceId: string,
    phase: "pre" | "post" | "bindings",
  ) {
    const upstreamNode = plan.resources[resourceId];
    if (!upstreamNode) {
      return yield* Effect.die(`Resource ${resourceId} not found`);
    }
    return {
      resourceId,
      upstreamNode,
      upstreamAttr: yield* phase === "post"
        ? Deferred.await(postcreateOutputs[resourceId])
        : Effect.race(
            Deferred.await(precreateOutputs[resourceId]),
            Deferred.await(postcreateOutputs[resourceId]),
          ),
    };
  });

  const resolveNodeUpstream = Effect.fn(function* (
    node: Create | Update | Replace,
    phase: "pre" | "post" | "bindings",
  ) {
    const upstreamDeps = {
      ...Output.resolveUpstream(node.props),
      ...(phase === "pre" ? {} : Output.resolveUpstream(node.bindings)),
    };
    const nodes = yield* Effect.all(
      Object.entries(upstreamDeps).map(([id]) => resolveUpstream(id, phase)),
    );
    return Object.fromEntries(
      nodes
        .filter((node) => node !== undefined)
        .map((node) => [node.resourceId, node.upstreamAttr]),
    );
  });

  const resolveBindingUpstream = Effect.fn(function* (
    node: Create | Update | Replace,
    phase: "post" | "bindings",
  ) {
    const upstreamDeps = Output.resolveUpstream(node.bindings);
    const nodes = yield* Effect.all(
      Object.entries(upstreamDeps).map(([id]) => resolveUpstream(id, phase)),
    );
    return Object.fromEntries(
      nodes
        .filter((node) => node !== undefined)
        .map((node) => [node.resourceId, node.upstreamAttr]),
    );
  });

  const resolvePropUpstream = Effect.fn(function* (
    node: Create | Update | Replace,
    phase: "pre" | "post",
  ) {
    const upstreamDeps = Output.resolveUpstream(node.props);
    const nodes = yield* Effect.all(
      Object.entries(upstreamDeps).map(([id]) => resolveUpstream(id, phase)),
    );
    return Object.fromEntries(
      nodes
        .filter((node) => node !== undefined)
        .map((node) => [node.resourceId, node.upstreamAttr]),
    );
  });

  const apply: (node: Apply) => Effect.Effect<any, never, never> = (node) =>
    Effect.gen(function* () {
      const logicalId = node.resource.LogicalId;
      const namespace = node.resource.Namespace;
      const fqn = node.resource.FQN;

      const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
        state.set({
          stack: stackName,
          stage: stage,
          fqn,
          value: { ...value, namespace } as S,
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

      const preOutput = precreateOutputs[logicalId];

      const succeedPre = Effect.fn(function* (attr: any) {
        // console.log("succeedPre", logicalId);
        yield* Deferred.succeed(preOutput, attr);
      });
      const succeedPost = Effect.fn(function* (attr: any) {
        // console.log("succeedPost", logicalId);
        yield* Deferred.succeed(postcreateOutputs[logicalId], attr);
      });
      const resolvePre = (node: Create | Update | Replace, attr: any) =>
        resolvePropUpstream(node, "pre").pipe(
          Effect.map((upstream) => ({
            ...upstream,
            ...(attr ? { [logicalId]: attr } : {}),
          })),
        );
      const resolvePropsPost = (node: Create | Update | Replace, attr: any) =>
        resolvePropUpstream(node, "post").pipe(
          Effect.map((upstream) => ({
            ...upstream,
            ...(attr ? { [logicalId]: attr } : {}),
          })),
        );
      const resolvePost = (node: Create | Update | Replace, attr: any) =>
        resolveNodeUpstream(node, "post").pipe(
          Effect.map((upstream) => ({
            ...upstream,
            ...(attr ? { [logicalId]: attr } : {}),
          })),
        );
      const resolveBindings = (node: Create | Update | Replace, attr: any) =>
        resolveBindingUpstream(node, "bindings").pipe(
          Effect.map((upstream) => ({
            ...upstream,
            ...(attr ? { [logicalId]: attr } : {}),
          })),
        );

      return yield* (outputs[logicalId] ??= yield* Effect.cached(
        Effect.gen(function* () {
          const report = (status: ApplyStatus) =>
            session.emit({
              kind: "status-change",
              id: logicalId,
              type: node.resource.Type,
              status,
            });

          if (node.action === "noop") {
            yield* Deferred.succeed(preOutput, node.state.attr);
            yield* succeedPost(node.state.attr);
            return node.state.attr;
          }

          const instanceId = yield* Effect.gen(function* () {
            if (node.action === "create" && !node.state?.instanceId) {
              const instanceId = yield* generateInstanceId();
              yield* commit<CreatingResourceState>({
                status: "creating",
                fqn,
                instanceId,
                logicalId,
                downstream: node.downstream,
                props: node.props,
                providerVersion: node.provider.version ?? 0,
                resourceType: node.resource.Type,
                bindings: excludeDeletedBindings(node.bindings),
                removalPolicy: node.resource.RemovalPolicy,
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
                fqn,
                instanceId,
                logicalId,
                downstream: node.downstream,
                props: node.props,
                providerVersion: node.provider.version ?? 0,
                resourceType: node.resource.Type,
                bindings: excludeDeletedBindings(node.bindings),
                old: node.state,
                deleteFirst: node.deleteFirst,
                removalPolicy: node.resource.RemovalPolicy,
              });
              return instanceId;
            } else if (node.state?.instanceId) {
              // we're in a create, update or delete state with a stable instanceId, use it
              return node.state.instanceId;
            }
            // this should never happen
            return yield* Effect.die(
              `Instance ID not found for resource '${logicalId}' and action is '${node.action}'`,
            );
          });

          const apply = Effect.gen(function* () {
            if (node.action === "create") {
              const upstream = yield* resolvePropsPost(node, undefined);

              const news = (yield* Output.evaluate(
                node.props,
                upstream,
              )) as Record<string, any>;

              const checkpoint = (attr: any) =>
                commit<CreatingResourceState>({
                  status: "creating",
                  fqn,
                  logicalId,
                  instanceId,
                  resourceType: node.resource.Type,
                  props: news,
                  attr,
                  providerVersion: node.provider.version ?? 0,
                  bindings: excludeDeletedBindings(node.bindings),
                  downstream: node.downstream,
                  removalPolicy: node.resource.RemovalPolicy,
                });

              if (!node.state) {
                yield* checkpoint(undefined);
              }

              let attr: any = node.state?.attr;
              if (attr !== undefined) {
                yield* succeedPre(attr);
              }
              if (
                node.action === "create" &&
                node.provider.precreate &&
                // pre-create is only designed to ensure the resource exists, if we have state.attr, then it already exists and should be skipped
                attr === undefined
              ) {
                yield* report("pre-creating");

                // stub the resource prior to resolving upstream resources or bindings if a stub is available
                attr = yield* node.provider.precreate({
                  id: logicalId,
                  news: node.props,
                  session: scopedSession,
                  instanceId,
                });

                yield* checkpoint(attr);

                yield* succeedPre(attr);
              }

              yield* report("creating");

              const bindingOutputs = yield* Output.evaluate(
                node.bindings,
                yield* resolveBindings(node, attr),
              ).pipe(Effect.map(excludeDeletedBindings));

              attr = yield* node.provider.create({
                id: logicalId,
                news,
                instanceId,
                bindings: bindingOutputs,
                session: scopedSession,
                output: attr,
              });

              yield* commit<CreatedResourceState>({
                status: "created",
                fqn,
                logicalId,
                instanceId,
                resourceType: node.resource.Type,
                props: news,
                attr,
                bindings: excludeDeletedBindings(node.bindings),
                providerVersion: node.provider.version ?? 0,
                downstream: node.downstream,
                removalPolicy: node.resource.RemovalPolicy,
              });
              // emit the output to downstream dependencies
              // we do this after committing to mitigate risk of state corruption
              yield* succeedPost(attr);

              yield* report("created");

              return attr;
            } else if (node.action === "update") {
              const upstream = yield* resolvePropsPost(node, node.state.attr);

              const news = (yield* Output.evaluate(
                node.props,
                upstream,
              )) as Record<string, any>;

              yield* node.state.status === "replaced"
                ? commit<ReplacedResourceState>({
                    ...node.state,
                    attr: node.state.attr,
                    props: news,
                  })
                : commit<UpdatingReourceState>({
                    status: "updating",
                    fqn,
                    logicalId,
                    instanceId,
                    resourceType: node.resource.Type,
                    props: news,
                    attr: node.state.attr,
                    providerVersion: node.provider.version ?? 0,
                    bindings: excludeDeletedBindings(node.bindings),
                    downstream: node.downstream,
                    old:
                      node.state.status === "updating"
                        ? node.state.old
                        : node.state,
                    removalPolicy: node.resource.RemovalPolicy,
                  });

              yield* succeedPre(node.state.attr);

              yield* report("updating");

              const previousProps =
                node.state.status === "created" ||
                node.state.status === "updated" ||
                node.state.status === "replaced"
                  ? node.state.props
                  : node.state.old.props;
              const bindingInputs = yield* havePropsChanged(previousProps, news)
                ? resolveBindings(node, node.state.attr)
                : resolvePost(node, node.state.attr);
              const bindingOutputs = yield* Output.evaluate(
                node.bindings,
                bindingInputs,
              ).pipe(Effect.map(excludeDeletedBindings));

              const attr = yield* node.provider.update({
                id: logicalId,
                news,
                instanceId,
                bindings: bindingOutputs,
                session: scopedSession,
                olds: previousProps,
                output: node.state.attr,
              });

              yield* succeedPost(attr);

              if (node.state.status === "replaced") {
                yield* commit<ReplacedResourceState>({
                  ...node.state,
                  attr,
                  props: news,
                });
              } else {
                yield* commit<UpdatedResourceState>({
                  status: "updated",
                  fqn,
                  logicalId,
                  instanceId,
                  resourceType: node.resource.Type,
                  props: news,
                  attr,
                  bindings: excludeDeletedBindings(node.bindings),
                  providerVersion: node.provider.version ?? 0,
                  downstream: node.downstream,
                  removalPolicy: node.resource.RemovalPolicy,
                });
              }

              yield* report("updated");

              return attr;
            } else if (node.action === "replace") {
              const checkpoint = <
                S extends ReplacingResourceState | ReplacedResourceState,
              >({
                status,
                attr,
              }: Pick<S, "status" | "attr">) =>
                commit<S>({
                  status,
                  fqn,
                  logicalId,
                  instanceId,
                  resourceType: node.resource.Type,
                  props: news,
                  attr,
                  providerVersion: node.provider.version ?? 0,
                  bindings: excludeDeletedBindings(node.bindings),
                  downstream: node.downstream,
                  old: state.old,
                  deleteFirst: node.deleteFirst,
                  removalPolicy: node.resource.RemovalPolicy,
                } as S);

              if (node.state.status === "replaced") {
                yield* succeedPost(node.state.attr);
                // we've already created the replacement resource, return the output
                return node.state.attr;
              }
              let state: ReplacingResourceState;
              if (node.state.status !== "replacing") {
                state = yield* commit<ReplacingResourceState>({
                  status: "replacing",
                  fqn,
                  logicalId,
                  instanceId,
                  resourceType: node.resource.Type,
                  props: node.props,
                  bindings: excludeDeletedBindings(node.bindings),
                  attr: undefined,
                  providerVersion: node.provider.version ?? 0,
                  deleteFirst: node.deleteFirst,
                  old: node.state,
                  downstream: node.downstream,
                  removalPolicy: node.resource.RemovalPolicy,
                });
              } else {
                state = node.state;
              }

              const news = (yield* Output.evaluate(
                node.props,
                yield* resolvePropsPost(node, state.attr),
              )) as Record<string, any>;

              let attr: any = state.attr;
              if (attr !== undefined) {
                yield* succeedPre(attr);
              }
              if (
                node.provider.precreate &&
                // pre-create is only designed to ensure the resource exists, if we have state.attr, then it already exists and should be skipped
                attr === undefined
              ) {
                yield* report("pre-creating");

                // stub the resource prior to resolving upstream resources or bindings if a stub is available
                attr = yield* node.provider.precreate({
                  id: logicalId,
                  news: node.props,
                  session: scopedSession,
                  instanceId,
                });

                yield* succeedPre(attr);

                yield* checkpoint({
                  status: "replacing",
                  attr,
                });
              }

              yield* report("creating replacement");

              // let bindings = excludeDeletedBindings(
              //   yield* Output.evaluate(node.bindings, upstream),
              // );

              const bindings = excludeDeletedBindings(
                yield* Output.evaluate(
                  node.bindings,
                  yield* resolveBindings(node, attr),
                ),
              );

              attr = yield* node.provider.create({
                id: logicalId,
                news,
                instanceId,
                bindings,
                session: scopedSession,
                output: attr,
              });

              yield* succeedPost(attr);

              yield* checkpoint<ReplacedResourceState>({
                status: "replaced",
                attr,
              });

              yield* report("created");
              return attr;
            }
            // @ts-expect-error - node is never, this should be unreachable
            return yield* Effect.die(`Unknown action: ${node.action}`);
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
      Object.entries(plan.resources).map(([id, node]) =>
        Effect.map(apply(node), (attr) => [id, attr]),
      ),
      { concurrency: "unbounded" },
    ),
  );
});

const collectGarbage = Effect.fnUntraced(function* (
  plan: Plan,
  session: PlanStatusSession,
) {
  const state = yield* State;
  const stack = yield* Stack;
  const stackName = stack.name;
  const stage = yield* Stage;

  const deletions: {
    [fqn in string]: Effect.Effect<void, StateStoreError, never>;
  } = {};

  // delete all replaced resources
  const replacedResources = yield* state.getReplacedResources({
    stack: stackName,
    stage: stage,
  });

  // deletionGraph is keyed by FQN for consistent lookup
  const deletionGraph = {
    ...plan.deletions,
    ...Object.fromEntries(
      replacedResources.map((replaced) => [
        toFqn(replaced.namespace, replaced.logicalId),
        replaced,
      ]),
    ),
  };

  const deleteResource: (
    node: Delete | ReplacedResourceState,
  ) => Effect.Effect<void, StateStoreError, never> = Effect.fnUntraced(
    function* (node: Delete | ReplacedResourceState) {
      const isDeleteNode = (
        node: Delete | ReplacedResourceState,
      ): node is Delete => "action" in node;

      const {
        logicalId,
        namespace,
        resourceType,
        instanceId,
        downstream,
        props,
        attr,
        provider,
      } = isDeleteNode(node)
        ? {
            logicalId: node.resource.LogicalId,
            namespace: node.resource.Namespace,
            resourceType: node.resource.Type,
            instanceId: node.state.instanceId,
            downstream: node.downstream,
            props: node.state.props,
            attr: node.state.attr,
            provider: node.provider,
          }
        : {
            logicalId: node.logicalId,
            namespace: node.namespace,
            resourceType: node.old.resourceType,
            instanceId: node.old.instanceId,
            downstream: node.old.downstream,
            props: node.old.props,
            attr: node.old.attr,
            provider: yield* getProviderByType(node.old.resourceType),
          };

      const fqn = toFqn(namespace, logicalId);

      const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
        state.set({
          stack: stackName,
          stage: stage,
          fqn,
          value: { ...value, namespace } as S,
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

      return yield* (deletions[fqn] ??= yield* Effect.cached(
        Effect.gen(function* () {
          yield* Effect.all(
            downstream.map((dep) =>
              dep !== fqn && dep in deletionGraph
                ? deleteResource(deletionGraph[dep] as Delete)
                : Effect.void,
            ),
            { concurrency: "unbounded" },
          );

          yield* report("deleting");

          if (isDeleteNode(node)) {
            if (node.resource.RemovalPolicy === "retain") {
              yield* state.delete({
                stack: stackName,
                stage: stage,
                fqn,
              });
              yield* report("deleted");
              return;
            }
            yield* commit<DeletingResourceState>({
              status: "deleting",
              fqn,
              logicalId,
              instanceId,
              resourceType,
              props,
              attr,
              downstream,
              providerVersion: provider.version ?? 0,
              bindings: excludeDeletedBindings(node.bindings),
              removalPolicy: node.resource.RemovalPolicy,
            });
          }

          if (attr !== undefined) {
            yield* provider.delete({
              id: logicalId,
              instanceId,
              olds: props as never,
              output: attr,
              session: scopedSession,
              bindings: [],
            });
          }

          if (isDeleteNode(node)) {
            yield* state.delete({
              stack: stackName,
              stage: stage,
              fqn,
            });
            yield* report("deleted");
          } else {
            yield* commit<CreatedResourceState>({
              status: "created",
              fqn,
              logicalId,
              instanceId,
              resourceType,
              props: node.props,
              attr: node.attr,
              providerVersion: provider.version ?? 0,
              downstream: node.downstream,
              bindings: excludeDeletedBindings(node.bindings),
              removalPolicy: node.removalPolicy,
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
    { concurrency: "unbounded" },
  );
});

const excludeDeletedBindings = (
  bindings: ReadonlyArray<ResourceBinding & { action?: string }>,
): ResourceBinding[] =>
  bindings.flatMap(({ action, namespace, sid, data }) =>
    action === "delete" ? [] : [{ namespace, sid, data }],
  );
