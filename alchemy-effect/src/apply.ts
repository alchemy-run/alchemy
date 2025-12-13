import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { Simplify } from "effect/Types";
import type { AnyBinding, BindingService } from "./binding.ts";
import type { ApplyStatus } from "./event.ts";
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
import { State } from "./state.ts";
import { App } from "./app.ts";
import { asEffect } from "./util.ts";
import { type ScopedPlanStatusSession, CLI } from "./cli/service.ts";

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
                (provider.reattach ? provider.reattach : provider.attach)(
                  input,
                ),
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

    const apply: (node: CRUD) => Effect.Effect<any, never, never> = (node) =>
      Effect.gen(function* () {
        const saveState = <Output>({
          output,
          bindings = node.bindings,
          news,
        }: {
          output: Output;
          bindings?: BindNode[];
          news: any;
        }) =>
          state
            .set({
              stack: app.name,
              stage: app.stage,
              resourceId: node.resource.id,
              value: {
                id: node.resource.id,
                type: node.resource.type,
                status: node.action === "create" ? "created" : "updated",
                props: news,
                output,
                bindings,
              },
            })
            .pipe(Effect.map(() => output));

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

            const createOrUpdate = Effect.fn(function* ({
              node,
              attr,
              phase,
            }: {
              node: Create | Update;
              attr: any;
              phase: "create" | "update";
            }) {
              const upstream = Object.fromEntries(
                yield* Effect.all(
                  Object.entries(Output.resolveUpstream(node.news)).map(
                    ([id]) =>
                      resolveUpstream(id).pipe(
                        Effect.map(({ upstreamAttr }) => [id, upstreamAttr]),
                      ),
                  ),
                ),
              );
              const news = yield* Output.evaluate(node.news, upstream);

              yield* report(phase === "create" ? "creating" : "updating");

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
                phase === "create" ? node.provider.create : node.provider.update
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
              }).pipe(
                // TODO(sam): partial checkpoints
                // checkpoint,
                Effect.tap(() =>
                  report(phase === "create" ? "created" : "updated"),
                ),
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
              });

              return output;
            });

            if (node.action === "noop") {
              return (yield* state.get({
                stack: app.name,
                stage: app.stage,
                resourceId: id,
              }))?.output;
            } else if (node.action === "create") {
              let attr: any;
              if (node.provider.precreate) {
                yield* Effect.logDebug("precreate", id);
                // stub the resource prior to resolving upstream resources or bindings if a stub is available
                attr = yield* node.provider.precreate({
                  id,
                  news: node.news,
                  session: scopedSession,
                });
              }

              yield* Effect.logDebug("create", id);
              return yield* createOrUpdate({
                node,
                attr,
                phase: "create",
              });
            } else if (node.action === "update") {
              yield* Effect.logDebug("update", id);
              return yield* createOrUpdate({
                node,
                attr: node.attributes,
                phase: "update",
              });
            } else if (node.action === "delete") {
              yield* Effect.logDebug("delete", id);
              yield* Effect.all(
                node.downstream.map((dep) =>
                  dep in plan.resources
                    ? apply(plan.resources[dep] as any)
                    : Effect.void,
                ),
              );
              yield* report("deleting");

              return yield* node.provider
                .delete({
                  id,
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
              const destroy = Effect.gen(function* () {
                yield* report("deleting");
                return yield* node.provider.delete({
                  id,
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
                      saveState({ news: node.news, output }),
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

    const nodes = [
      ...Object.entries(plan.resources),
      ...Object.entries(plan.deletions),
    ];

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
