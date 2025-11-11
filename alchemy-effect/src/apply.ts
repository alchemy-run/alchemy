import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Simplify } from "effect/Types";
import { PlanReviewer, type PlanRejected } from "./approve.ts";
import type { AnyBinding, BindingService } from "./binding.ts";
import type { ApplyEvent, ApplyStatus } from "./event.ts";
import {
  type BindNode,
  type Create,
  type CRUD,
  type Delete,
  type Plan,
  type Update,
} from "./plan.ts";
import type { Resource } from "./resource.ts";
import { State } from "./state.ts";

export interface PlanStatusSession {
  emit: (event: ApplyEvent) => Effect.Effect<void>;
  done: () => Effect.Effect<void>;
}

export interface ScopedPlanStatusSession extends PlanStatusSession {
  note: (note: string) => Effect.Effect<void>;
}

export class PlanStatusReporter extends Context.Tag("PlanStatusReporter")<
  PlanStatusReporter,
  {
    start(plan: Plan): Effect.Effect<PlanStatusSession, never>;
  }
>() {}

export const apply = <P extends Plan, Err, Req>(
  plan: Effect.Effect<P, Err, Req>,
) =>
  plan.pipe(
    Effect.flatMap((plan) =>
      Effect.gen(function* () {
        const state = yield* State;
        const outputs = {} as Record<string, Effect.Effect<any, any>>;
        const reviewer = yield* Effect.serviceOption(PlanReviewer);

        if (Option.isSome(reviewer)) {
          yield* reviewer.value.approve(plan);
        }

        const events = yield* Effect.serviceOption(PlanStatusReporter);

        const session = Option.isSome(events)
          ? yield* events.value.start(plan)
          : ({
              emit: () => Effect.void,
              done: () => Effect.void,
            } satisfies PlanStatusSession);
        const { emit, done } = session;

        const constOrEffect = <T, Err = never, Req = never>(
          effect: T | Effect.Effect<T>,
        ): Effect.Effect<T, Err, Req> =>
          Effect.isEffect(effect) ? effect : Effect.succeed(effect);

        const resolveBindingUpstream = Effect.fn(function* ({
          node,
          resource,
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
          const upstreamNode = plan.resources[resourceId];
          const upstreamAttr = resource
            ? yield* apply(upstreamNode)
            : yield* Effect.dieMessage(`Resource ${resourceId} not found`);

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
                  return yield* constOrEffect(provider.attach(input));
                } else if (node.action === "reattach") {
                  // reattach is optional, we fall back to attach if it's not available
                  return yield* constOrEffect(
                    (provider.reattach ? provider.reattach : provider.attach)(
                      input,
                    ),
                  );
                } else if (node.action === "detach" && provider.detach) {
                  return yield* constOrEffect(
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
                  const bindingOutput = yield* constOrEffect(
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

        const apply: (node: CRUD) => Effect.Effect<any, never, never> = (
          node,
        ) =>
          Effect.gen(function* () {
            const checkpoint = <Out, Err>(
              effect: Effect.Effect<Out, Err, never>,
            ) => effect.pipe(Effect.flatMap((output) => saveState({ output })));

            const saveState = <Output>({
              output,
              bindings = node.bindings,
            }: {
              output: Output;
              bindings?: BindNode[];
            }) =>
              state
                .set(node.resource.id, {
                  id: node.resource.id,
                  type: node.resource.type,
                  status: node.action === "create" ? "created" : "updated",
                  props: node.resource.props,
                  output,
                  bindings,
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
                  node: Create<Resource> | Update<Resource>;
                  attr: any;
                  phase: "create" | "update";
                }) {
                  yield* report(phase === "create" ? "creating" : "updating");

                  let bindingOutputs = yield* attachBindings({
                    resource,
                    bindings: node.bindings,
                    target: {
                      id,
                      props: node.news,
                      attr,
                    },
                  });

                  const output: any = yield* (
                    phase === "create"
                      ? node.provider.create
                      : node.provider.update
                  )({
                    id,
                    news: node.news,
                    bindings: bindingOutputs,
                    session: scopedSession,
                  }).pipe(
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
                      props: node.news,
                      attr,
                    },
                  });

                  yield* saveState({
                    output,
                    bindings: node.bindings.map((binding, i) => ({
                      ...binding,
                      attr: bindingOutputs[i],
                    })),
                  });

                  return output;
                });

                if (node.action === "noop") {
                  return (yield* state.get(id))?.output;
                } else if (node.action === "create") {
                  let attr: any;
                  if (node.provider.precreate) {
                    // stub the resource prior to resolving upstream resources or bindings if a stub is available
                    attr = yield* node.provider.precreate({
                      id,
                      news: node.news,
                      session: scopedSession,
                    });
                  }

                  return yield* createOrUpdate({
                    node,
                    attr,
                    phase: "create",
                  });
                } else if (node.action === "update") {
                  return yield* createOrUpdate({
                    node,
                    attr: node.attributes,
                    phase: "update",
                  });
                } else if (node.action === "delete") {
                  yield* Effect.all(
                    node.downstream.map((dep) =>
                      dep in plan.resources
                        ? apply(
                            plan.resources[
                              dep
                            ] as P["resources"][keyof P["resources"]],
                          )
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
                      Effect.flatMap(() => state.delete(id)),
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
                    return yield* (
                      node.provider
                        .create({
                          id,
                          news: node.news,
                          // TODO(sam): these need to only include attach actions
                          bindings: yield* attachBindings({
                            resource,
                            bindings: node.bindings,
                            target: {
                              id,
                              props: node.news,
                              attr: node.attributes,
                            },
                          }),
                          session: scopedSession,
                        })
                        // TODO(sam): delete and create will conflict here, we need to extend the state store for replace
                        .pipe(
                          checkpoint,
                          Effect.tap(() => report("created")),
                        )
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
        return resources;
      }),
    ),
  ) as Effect.Effect<
    "update" extends P["phase"]
      ?
          | {
              [id in keyof P["resources"]]: P["resources"][id] extends
                | Delete<Resource>
                | undefined
                | never
                ? never
                : Simplify<P["resources"][id]["resource"]["attr"]>;
            }
          // union distribution isn't happening, so we gotta add this additional void here just in case
          | ("destroy" extends P["phase"] ? void : never)
      : void,
    Err | PlanRejected,
    Req
  >;
