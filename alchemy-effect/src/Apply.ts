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

interface ResourceTracker {
  output: any;
  props: any;
  bindings: ResourceBinding[];
  instanceId: string;
}

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
    const state = yield* State;
    const stack = yield* Stack;
    const stage = yield* Stage;
    const stackName = stack.name;

    const tracker: Record<string, ResourceTracker> = {};
    const terminalStatuses = new Map<
      string,
      {
        id: string;
        type: string;
        status: Extract<ApplyStatus, "created" | "updated">;
      }
    >();

    yield* executePlan(
      plan,
      tracker,
      terminalStatuses,
      session,
      state,
      stackName,
      stage,
    );

    // TODO(sam): support roll back to previous state if errors occur during expansion
    // -> RISK: some UPDATEs may not be reversible (i.e. trigger replacements)
    // TODO(sam): should pivot be done separately? E.g shift traffic?

    yield* collectGarbage(plan, session);

    yield* converge(
      plan,
      tracker,
      terminalStatuses,
      session,
      state,
      stackName,
      stage,
    );

    yield* Effect.forEach(
      Array.from(terminalStatuses.values()),
      ({ id, type, status }) =>
        session.emit({ kind: "status-change", id, type, status }),
      { concurrency: "unbounded" },
    );

    yield* session.done();

    if (Object.keys(plan.resources).length === 0) {
      return undefined;
    }

    const outputs = Object.fromEntries(
      Object.entries(tracker).map(([fqn, t]) => [fqn, t.output]),
    );
    return yield* Output.evaluate(plan.output, outputs);
  });

// ── Phase 1: concurrent initial execution ──────────────────────────────────
//
// Each resource gets a Deferred<void> that signals "I have some output
// available in `tracker`." Resources with `precreate` signal early so that
// downstream resources can resolve stable identifiers without deadlocking.
// The actual output lives in the mutable `tracker` map, not in the Deferred.

const executePlan = Effect.fnUntraced(function* (
  plan: Plan,
  tracker: Record<string, ResourceTracker>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends ResourceState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
) {
  const ready = Object.fromEntries(
    yield* Effect.all(
      Object.keys(plan.resources).map((fqn) =>
        Effect.map(Deferred.make<void>(), (d) => [fqn, d] as const),
      ),
    ),
  ) as Record<string, Deferred.Deferred<void>>;

  const getOutputs = (): Record<string, any> =>
    Object.fromEntries(
      Object.entries(tracker).map(([fqn, t]) => [fqn, t.output]),
    );

  const waitForDeps = (fqns: string[]) =>
    Effect.all(
      fqns
        .filter((fqn) => fqn in ready)
        .map((fqn) => Deferred.await(ready[fqn])),
    );

  yield* Effect.all(
    Object.entries(plan.resources).map(([fqn, node]) =>
      executeNode(
        fqn,
        node,
        tracker,
        ready,
        terminalStatuses,
        session,
        state,
        stackName,
        stage,
        getOutputs,
        waitForDeps,
      ),
    ),
    { concurrency: "unbounded" },
  );
});

const executeNode = (
  fqn: string,
  node: Apply,
  tracker: Record<string, ResourceTracker>,
  ready: Record<string, Deferred.Deferred<void>>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends ResourceState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
  getOutputs: () => Record<string, any>,
  waitForDeps: (fqns: string[]) => Effect.Effect<void[], never, never>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const logicalId = node.resource.LogicalId;
    const namespace = node.resource.Namespace;

    const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
      state.set({
        stack: stackName,
        stage,
        fqn,
        value: { ...value, namespace } as S,
      });

    const scopedSession = {
      ...session,
      note: (note: string) =>
        session.emit({ id: logicalId, kind: "annotate", message: note }),
    } satisfies ScopedPlanStatusSession;

    const report = (status: ApplyStatus) =>
      session.emit({
        kind: "status-change",
        id: logicalId,
        type: node.resource.Type,
        status,
      });

    const markTerminal = (status: "created" | "updated") =>
      Effect.sync(() => {
        terminalStatuses.set(fqn, {
          id: logicalId,
          type: node.resource.Type,
          status,
        });
      });

    const signalReady = Deferred.succeed(ready[fqn], void 0);

    const storeAndSignal = (t: ResourceTracker) =>
      Effect.gen(function* () {
        tracker[fqn] = t;
        yield* signalReady;
      });

    // ── noop ──

    if (node.action === "noop") {
      yield* storeAndSignal({
        output: node.state.attr,
        props: node.state.props,
        bindings: node.state.bindings ?? [],
        instanceId: node.state.instanceId,
      });
      return;
    }

    const allUpstreamFqns = () => {
      const propDeps = Object.keys(Output.resolveUpstream(node.props));
      const bindingDeps = Object.keys(Output.resolveUpstream(node.bindings));
      return [...new Set([...propDeps, ...bindingDeps])];
    };

    // ── instance ID ──

    const instanceId = yield* Effect.gen(function* () {
      if (node.action === "create" && !node.state?.instanceId) {
        const id = yield* generateInstanceId();
        yield* commit<CreatingResourceState>({
          status: "creating",
          fqn,
          logicalId,
          instanceId: id,
          downstream: node.downstream,
          props: node.props,
          providerVersion: node.provider.version ?? 0,
          resourceType: node.resource.Type,
          bindings: excludeDeletedBindings(node.bindings),
          removalPolicy: node.resource.RemovalPolicy,
        });
        return id;
      } else if (node.action === "replace") {
        if (
          node.state.status === "replaced" ||
          node.state.status === "replacing"
        ) {
          return node.state.instanceId;
        }
        const id = yield* generateInstanceId();
        yield* commit<ReplacingResourceState>({
          status: "replacing",
          fqn,
          logicalId,
          instanceId: id,
          downstream: node.downstream,
          props: node.props,
          providerVersion: node.provider.version ?? 0,
          resourceType: node.resource.Type,
          bindings: excludeDeletedBindings(node.bindings),
          old: node.state,
          deleteFirst: node.deleteFirst,
          removalPolicy: node.resource.RemovalPolicy,
        });
        return id;
      } else if (node.state?.instanceId) {
        return node.state.instanceId;
      }
      return yield* Effect.die(
        `Instance ID not found for resource '${logicalId}' and action is '${node.action}'`,
      );
    });

    // ── lifecycle ──

    yield* Effect.gen(function* () {
      // ── create ──
      if (node.action === "create") {
        if (!node.state) {
          yield* commit<CreatingResourceState>({
            status: "creating",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            attr: undefined,
            providerVersion: node.provider.version ?? 0,
            bindings: excludeDeletedBindings(node.bindings),
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
          });
        }

        let attr: any = node.state?.attr;

        if (attr !== undefined) {
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        if (node.provider.precreate && attr === undefined) {
          yield* report("pre-creating");
          attr = yield* node.provider.precreate({
            id: logicalId,
            news: node.props,
            session: scopedSession,
            instanceId,
          });
          yield* commit<CreatingResourceState>({
            status: "creating",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            attr,
            providerVersion: node.provider.version ?? 0,
            bindings: excludeDeletedBindings(node.bindings),
            downstream: node.downstream,
            removalPolicy: node.resource.RemovalPolicy,
          });
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        yield* report("creating");

        yield* waitForDeps(allUpstreamFqns());
        const outputs = getOutputs();

        const news = (yield* Output.evaluate(
          node.props,
          outputs,
        )) as Record<string, any>;

        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

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

        tracker[fqn] = {
          output: attr,
          props: news,
          bindings: bindingOutputs,
          instanceId,
        };
        yield* signalReady;

        yield* markTerminal("created");
        return;
      }

      // ── update ──
      if (node.action === "update") {
        yield* storeAndSignal({
          output: node.state.attr,
          props: node.state.props,
          bindings: node.state.bindings ?? [],
          instanceId,
        });

        yield* waitForDeps(allUpstreamFqns());
        const outputs = getOutputs();

        const news = (yield* Output.evaluate(
          node.props,
          outputs,
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

        yield* report("updating");

        const previousProps =
          node.state.status === "created" ||
          node.state.status === "updated" ||
          node.state.status === "replaced"
            ? node.state.props
            : node.state.old.props;

        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

        const attr = yield* node.provider.update({
          id: logicalId,
          news,
          instanceId,
          bindings: bindingOutputs,
          session: scopedSession,
          olds: previousProps,
          output: node.state.attr,
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

        tracker[fqn] = {
          output: attr,
          props: news,
          bindings: bindingOutputs,
          instanceId,
        };

        yield* markTerminal("updated");
        return;
      }

      // ── replace ──
      if (node.action === "replace") {
        if (node.state.status === "replaced") {
          tracker[fqn] = {
            output: node.state.attr,
            props: node.state.props,
            bindings: node.state.bindings ?? [],
            instanceId,
          };
          yield* signalReady;
          yield* markTerminal("created");
          return;
        }

        let replState: ReplacingResourceState;
        if (node.state.status !== "replacing") {
          replState = yield* commit<ReplacingResourceState>({
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
          replState = node.state;
        }

        let attr: any = replState.attr;

        if (attr !== undefined) {
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        if (node.provider.precreate && attr === undefined) {
          yield* report("pre-creating");
          attr = yield* node.provider.precreate({
            id: logicalId,
            news: node.props,
            session: scopedSession,
            instanceId,
          });
          yield* commit<ReplacingResourceState>({
            status: "replacing",
            fqn,
            logicalId,
            instanceId,
            resourceType: node.resource.Type,
            props: node.props,
            attr,
            providerVersion: node.provider.version ?? 0,
            bindings: excludeDeletedBindings(node.bindings),
            downstream: node.downstream,
            old: replState.old,
            deleteFirst: node.deleteFirst,
            removalPolicy: node.resource.RemovalPolicy,
          });
          yield* storeAndSignal({
            output: attr,
            props: {},
            bindings: [],
            instanceId,
          });
        }

        yield* report("creating replacement");

        yield* waitForDeps(allUpstreamFqns());
        const outputs = getOutputs();

        const news = (yield* Output.evaluate(
          node.props,
          outputs,
        )) as Record<string, any>;

        const bindingOutputs = excludeDeletedBindings(
          yield* Output.evaluate(node.bindings, outputs),
        );

        attr = yield* node.provider.create({
          id: logicalId,
          news,
          instanceId,
          bindings: bindingOutputs,
          session: scopedSession,
          output: attr,
        });

        yield* commit<ReplacedResourceState>({
          status: "replaced",
          fqn,
          logicalId,
          instanceId,
          resourceType: node.resource.Type,
          props: news,
          attr,
          providerVersion: node.provider.version ?? 0,
          bindings: excludeDeletedBindings(node.bindings),
          downstream: node.downstream,
          old: replState.old,
          deleteFirst: node.deleteFirst,
          removalPolicy: node.resource.RemovalPolicy,
        });

        tracker[fqn] = {
          output: attr,
          props: news,
          bindings: bindingOutputs,
          instanceId,
        };
        yield* signalReady;

        yield* markTerminal("created");
        return;
      }

      // @ts-expect-error - node is never, this should be unreachable
      return yield* Effect.die(`Unknown action: ${node.action}`);
    }).pipe(Effect.provide(Layer.succeed(InstanceId, instanceId)));
  }) as Effect.Effect<void, never, never>;

// ── Phase 3: imperative convergence loop ───────────────────────────────────
//
// After the initial concurrent pass, some resources may have been created
// with stale upstream values (e.g. a precreate stub instead of the final
// output). Walk the plan and re-evaluate each resource's props/bindings
// against the current tracker outputs. Call provider.update for any
// resource whose resolved inputs differ from what it was last applied with.
// Repeat until no resource needs updating.

const converge = Effect.fnUntraced(function* (
  plan: Plan,
  tracker: Record<string, ResourceTracker>,
  terminalStatuses: Map<
    string,
    {
      id: string;
      type: string;
      status: Extract<ApplyStatus, "created" | "updated">;
    }
  >,
  session: PlanStatusSession,
  state: {
    set: <V extends ResourceState>(req: {
      stack: string;
      stage: string;
      fqn: string;
      value: V;
    }) => Effect.Effect<V, StateStoreError, never>;
  },
  stackName: string,
  stage: string,
) {
  for (let pass = 0; pass < 10; pass++) {
    let anyUpdated = false;

    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (node.action === "noop") continue;
      if (!tracker[fqn]) continue;

      const outputs = Object.fromEntries(
        Object.entries(tracker).map(([k, t]) => [k, t.output]),
      );

      const newProps = (yield* Output.evaluate(
        node.props,
        outputs,
      )) as Record<string, any>;

      const newBindings = excludeDeletedBindings(
        yield* Output.evaluate(node.bindings, outputs),
      );

      const oldProps = tracker[fqn].props;
      const oldBindings = tracker[fqn].bindings;

      const propsChanged = havePropsChanged(oldProps, newProps);
      const bindingsChanged =
        JSON.stringify(oldBindings) !== JSON.stringify(newBindings);

      if (!propsChanged && !bindingsChanged) continue;

      anyUpdated = true;

      const logicalId = node.resource.LogicalId;
      const namespace = node.resource.Namespace;
      const instanceId = tracker[fqn].instanceId;

      const scopedSession = {
        ...session,
        note: (note: string) =>
          session.emit({ id: logicalId, kind: "annotate", message: note }),
      } satisfies ScopedPlanStatusSession;

      const attr = yield* node.provider
        .update({
          id: logicalId,
          news: newProps,
          instanceId,
          bindings: newBindings,
          session: scopedSession,
          olds: oldProps,
          output: tracker[fqn].output,
        })
        .pipe(Effect.provide(Layer.succeed(InstanceId, instanceId)));

      tracker[fqn] = {
        output: attr,
        props: newProps,
        bindings: newBindings,
        instanceId,
      };

      yield* state.set({
        stack: stackName,
        stage,
        fqn,
        value: {
          status: "updated",
          fqn,
          logicalId,
          instanceId,
          resourceType: node.resource.Type,
          props: newProps,
          attr,
          providerVersion: node.provider.version ?? 0,
          bindings: excludeDeletedBindings(node.bindings),
          downstream: node.downstream,
          namespace,
          removalPolicy: node.resource.RemovalPolicy,
        } as UpdatedResourceState,
      });

      terminalStatuses.set(fqn, {
        id: logicalId,
        type: node.resource.Type,
        status: "updated",
      });
    }

    if (!anyUpdated) break;
  }
});

// ── Phase 2: delete orphans and old replaced resources ─────────────────────

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

  const replacedResources = yield* state.getReplacedResources({
    stack: stackName,
    stage,
  });

  const deletionGraph = {
    ...plan.deletions,
    ...Object.fromEntries(
      replacedResources.map((replaced) => [
        toFqn(replaced.namespace, replaced.logicalId),
        replaced,
      ]),
    ),
  };

  const deleteResource = (
    node: Delete | ReplacedResourceState,
    ancestors: ReadonlySet<string> = new Set(),
  ): Effect.Effect<void, StateStoreError, never> =>
    Effect.gen(function* () {
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
      const nextAncestors = new Set(ancestors).add(fqn);

      const commit = <S extends ResourceState>(value: Omit<S, "namespace">) =>
        state.set({
          stack: stackName,
          stage,
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
              dep !== fqn && dep in deletionGraph && !ancestors.has(dep)
                ? deleteResource(deletionGraph[dep] as Delete, nextAncestors)
                : Effect.void,
            ),
            { concurrency: "unbounded" },
          );

          yield* report("deleting");

          if (isDeleteNode(node)) {
            if (node.resource.RemovalPolicy === "retain") {
              yield* state.delete({
                stack: stackName,
                stage,
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
              stage,
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
    });

  yield* Effect.all(
    Object.values(deletionGraph)
      .filter((node) => node !== undefined)
      .map((node) => deleteResource(node)),
    { concurrency: "unbounded" },
  );
});

const excludeDeletedBindings = (
  bindings: ReadonlyArray<ResourceBinding & { action?: string }>,
): ResourceBinding[] =>
  bindings.flatMap(({ action, namespace, sid, data }) =>
    action === "delete" ? [] : [{ namespace, sid, data }],
  );
