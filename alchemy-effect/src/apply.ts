import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import { App } from "./app.ts";
import type { AnyBinding, BindingService } from "./binding.ts";
import { CLI, type ScopedPlanStatusSession } from "./cli/service.ts";
import type { ApplyStatus } from "./event.ts";
import { generateInstanceId } from "./instance-id.ts";
import * as Output from "./output.ts";
import {
  plan,
  type BindNode,
  type Create,
  type CRUD,
  type Delete,
  type DerivePlan,
  type IPlan,
  type Providers,
  type Update,
} from "./plan.ts";
import type { Instance } from "./policy.ts";
import type { AnyResource, Resource } from "./resource.ts";
import type { AnyService } from "./service.ts";
import {
  type ReplacingResourceState,
  type ResourceState,
  CreatingResourceState,
  State,
  type ResourceStatus,
} from "./state.ts";
import { asEffect } from "./util.ts";

export type ApplyEffect<P extends IPlan, Err = never, Req = never> = Effect.Effect<
  {
    [k in keyof AppliedPlan<P>]: AppliedPlan<P>[k];
  },
  Err,
  Req
>;

export type AppliedPlan<P extends IPlan> = {
  [id in keyof P["resources"]]: P["resources"][id] extends Delete<Resource> | undefined | never
    ? never
    : Simplify<P["resources"][id]["resource"]["attr"]>;
};

export const apply = <const Resources extends (AnyService | AnyResource)[] = never>(
  ...resources: Resources
): ApplyEffect<
  DerivePlan<Instance<Resources[number]>>,
  never,
  State | Providers<Instance<Resources[number]>>
  // TODO(sam): don't cast to any
> => plan(...resources).pipe(Effect.flatMap(applyPlan)) as any;

export const applyPlan = <P extends IPlan>(plan: P) =>
  Effect.gen(function* () {
    const state = yield* State;
    // TODO(sam): rename terminology to Stack
    const app = yield* App;
    const outputs = {} as Record<string, Effect.Effect<any, any, State>>;

    const cli = yield* CLI;

    const session = yield* cli.startApplySession(plan);
    const { emit, done } = session;

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

            if (provider.postattach && (node.action === "attach" || node.action === "reattach")) {
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

    const apply: (node: CRUD) => Effect.Effect<any, never, never> = (node) =>
      Effect.gen(function* () {
        const resourceProvider = node.provider;

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
              emit({
                kind: "status-change",
                id,
                type: node.resource.type,
                status,
              });

            const instanceId = yield* Effect.gen(function* () {
              if (node.instanceId) {
                return node.instanceId;
              } else if (node.action === "create") {
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
                const instanceId = yield* generateInstanceId();
                yield* commit<ReplacingResourceState>({
                  status: "replacing",
                  instanceId,
                  logicalId: id,
                  downstream: node.downstream,
                  props: node.news,
                  providerVersion: node.provider.version ?? 0,
                  resourceType: node.resource.type,
                  bindings: node.bindings,
                  old:
                    node.state.status === "created" || node.state.status === "updated"
                      ? node.state
                      : node.state.old,
                });
                return instanceId;
              }
              // this should never happen
              return yield* Effect.dieMessage(
                `Instance ID not found for resource '${id}' and action is '${node.action}'`,
              );
            });

            if (node.action === "noop") {
              return node.output;
            } else if (node.action === "create" || node.action === "update") {
              let attr: any;
              if (node.action === "create" && node.provider.precreate) {
                yield* Effect.logDebug("precreate", id);
                // stub the resource prior to resolving upstream resources or bindings if a stub is available
                attr = yield* node.provider.precreate({
                  id,
                  news: node.props,
                  session: scopedSession,
                  instanceId,
                });
              }

              const upstream = Object.fromEntries(
                yield* Effect.all(
                  Object.entries(Output.resolveUpstream(node.props)).map(([id]) =>
                    resolveUpstream(id).pipe(Effect.map(({ upstreamAttr }) => [id, upstreamAttr])),
                  ),
                ),
              );
              const news = (yield* Output.evaluate(node.props, upstream)) as Record<string, any>;

              yield* report(node.action === "create" ? "creating" : "updating");

              let bindingOutputs = yield* attachBindings({
                resource,
                bindings: node.bindings,
                target: {
                  id,
                  props: news,
                  attr,
                },
              });

              const output: any = yield* (
                node.action === "create" ? node.provider.create : node.provider.update
              )({
                id,
                news,
                bindings: bindingOutputs,
                session: scopedSession,
                ...(node.action === "update"
                  ? {
                      output: node.output,
                      olds: node.olds,
                    }
                  : {}),
                instanceId,
              }).pipe(
                // TODO(sam): partial checkpoints
                // checkpoint,
                Effect.tap(() => report(node.action === "create" ? "created" : "updated")),
              );

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

              yield* saveState({
                news,
                output,
                bindings: node.bindings.map((binding, i) => ({
                  ...binding,
                  attr: bindingOutputs[i],
                })),
                instanceId,
                olds: node.action === "create" ? undefined : node.olds,
              });
            } else if (node.action === "delete") {
              yield* Effect.logDebug("delete", id);
              yield* Effect.all(
                node.downstream.map((dep) =>
                  dep in plan.resources
                    ? apply(plan.resources[dep] as any)
                    : dep in plan.deletions
                      ? apply(plan.deletions[dep] as any)
                      : Effect.void,
                ),
              );
              yield* report("deleting");

              return yield* node.provider
                .delete({
                  id,
                  instanceId,
                  olds: node.olds,
                  output: node.output,
                  session: scopedSession,
                  bindings: [],
                })
                .pipe(
                  Effect.flatMap(() =>
                    state.delete({
                      stack: app.name,
                      stage: app.stage,
                      resourceId: id,
                    }),
                  ),
                  Effect.tap(() => report("deleted")),
                );
            } else if (node.action === "replace") {
              // TODO(sam): create new instanceid, commit intent to replace to state, then orchestrate appropriately
              const destroy = Effect.gen(function* () {
                yield* report("deleting");
                return yield* node.provider.delete({
                  id,
                  instanceId,
                  olds: node.olds,
                  output: node.output,
                  session: scopedSession,
                  bindings: [],
                });
              });
              const create = Effect.gen(function* () {
                yield* report("creating");

                // TODO(sam): delete and create will conflict here, we need to extend the state store for replace
                return yield* node.provider
                  .create({
                    id,
                    instanceId,
                    news: node.news,
                    // TODO(sam): these need to only include attach actions
                    bindings: yield* attachBindings({
                      resource,
                      bindings: node.bindings,
                      target: {
                        id,
                        // TODO(sam): resolve the news
                        props: node.news,
                        attr: node.attributes,
                      },
                    }),
                    session: scopedSession,
                  })
                  .pipe(
                    Effect.tap((output) =>
                      saveState({
                        //
                        news: node.news,
                        output,
                        instanceId,
                      }),
                    ),
                  );
              });
              if (!node.deleteFirst) {
                yield* destroy;
                return outputs;
              } else {
                yield* destroy;
                return yield* create;
              }
            }
          }),
        ));
      }) as Effect.Effect<any, never, never>;

    const nodes = [...Object.entries(plan.resources), ...Object.entries(plan.deletions)];

    const resources: any = Object.fromEntries(
      yield* Effect.all(
        nodes.map(
          Effect.fn(function* ([id, node]) {
            return [id, yield* apply(node as CRUD)];
          }),
        ),
      ),
    );
    yield* done();
    if (Object.keys(plan.resources).length === 0) {
      // all resources are deleted, return undefined
      return undefined;
    }
    return resources as {
      [k in keyof AppliedPlan<P>]: AppliedPlan<P>[k];
    };
  });
