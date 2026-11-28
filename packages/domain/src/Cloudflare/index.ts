import {
  DurableObjectCallbacks,
  outsideAlarmPass,
} from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import {
  type DurableObjectJurisdiction,
  type DurableObjectLocationHint,
  type InlineDurableObjectProps,
} from "@alchemy.run/cloudflare/Workers/DurableObject";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { makeRpcStub } from "@alchemy.run/cloudflare/Workers/Rpc";
import { Worker as CloudflareWorker, type Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import {
  deferredExecutionContext,
  WorkerEnvironment,
  WorkerExecutionContext,
} from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import {
  sleep,
  task,
  Workflow,
  type WorkflowImpl,
} from "@alchemy.run/cloudflare/Workflows/Workflow";
import { hostedBy, own } from "alchemy/CapabilityGraph";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine, provideCallbacks } from "alchemy/Workers/DurableObjectEngine";
import { StorageName } from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { WorkflowEngine } from "effect/workflow";
import * as Backfill from "../Backfill.ts";
import {
  Attachment,
  className,
  consumerClass,
  generationOfTarget,
  type Host,
  makePlatform,
  type ModelLayout,
  type Retention,
  retentionWindows,
  type Namespace,
  ObjectState,
  RUN_ROOT,
  runClass,
  SUBSCRIPTION_HEADER,
  TRANSIT_RETRY,
  unwrapDefects,
} from "../DurableObjects.ts";
import { type Platform, type Subscription } from "../Platform.ts";
import { Backfill as BackfillRun } from "./Backfill.ts";
import {
  type Namespace as CloudflareNamespace,
  type ObjectImpl as CloudflareImpl,
  declare,
  domainClass,
  domainClassName,
  type LegacyClass,
  objectState,
  onCloudflare,
  routeView,
} from "./DomainClass.ts";
import { BEFORE_VERSIONS, type RetiringDomainClass } from "./Migration.ts";
import type { Providers } from "./Providers.ts";
import { DeployVersion } from "./Version.ts";

export type { Retention } from "../DurableObjects.ts";

export { Backfill, BackfillFailed, BackfillStillRunning } from "./Backfill.ts";
export { D1KeyStore, type D1KeyStoreOptions } from "./D1KeyStore.ts";
export { providers, Providers, type ProviderRequirements } from "./Providers.ts";
export { SecretKeyWrap } from "./SecretKeyWrap.ts";

/** Where the platform keeps the model's Durable Objects. */
interface Placement {
  readonly jurisdiction: DurableObjectJurisdiction | undefined;
  readonly locationHint: DurableObjectLocationHint | undefined;
}

/**
 * A namespace whose objects live in the platform's jurisdiction and are
 * created near its location hint. Every namespace Domain reaches goes
 * through here, so no kind of object is left outside either.
 */
const placed = (namespace: CloudflareNamespace, placement: Placement): CloudflareNamespace => {
  const inside =
    placement.jurisdiction === undefined
      ? namespace
      : namespace.jurisdiction(placement.jurisdiction);
  return placement.locationHint === undefined ? inside : hinted(inside, placement.locationHint);
};

/** A namespace that creates each new object near `locationHint`. */
const hinted = (
  namespace: CloudflareNamespace,
  locationHint: DurableObjectLocationHint,
): CloudflareNamespace => ({
  ...namespace,
  getByName: (name, options) => namespace.getByName(name, { locationHint, ...options }),
  jurisdiction: (inside) => hinted(namespace.jurisdiction(inside), locationHint),
});

/**
 * Hand `effect` to the current invocation's `waitUntil`: the Durable Object's
 * inside one, otherwise the Worker event's. A Workflow step, or code outside
 * any handler, has neither.
 */
const handToInvocation = (effect: Effect.Effect<void>): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.serviceOption(RuntimeContext);
    if (Option.isNone(runtime)) return false;
    const state = yield* Effect.serviceOption(DurableObjectState);
    // The reference's default is no event: its methods would die.
    const execution = yield* WorkerExecutionContext;
    if (Option.isNone(state) && execution === deferredExecutionContext) return false;
    yield* (
      Option.isSome(state)
        ? // Outside the alarm pass, so a callback's alarm isn't held open by it.
          state.value.waitUntil(outsideAlarmPass(effect))
        : execution.waitUntil(effect)
    ).pipe(Effect.provideService(RuntimeContext, runtime.value));
    return true;
  });
/**
 * Forward a WebSocket upgrade (the current request) to the instance that owns
 * `key`, carrying the subscription. The Worker sets the header, overwriting
 * any a client sent, so the object can trust it.
 */
const connectTo = (namespace: Namespace, key: string, subscription: Subscription) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const forwarded = request.modify({
      headers: Headers.set(
        request.headers,
        SUBSCRIPTION_HEADER,
        JSON.stringify({ key, subscription } satisfies Attachment),
      ),
    });
    // Like every other call, ride out a deploy's rollout: an instance still
    // running the previous script cannot upgrade, so retry until one does.
    const response = yield* (namespace as CloudflareNamespace)
      .getByName(key)
      .fetch(forwarded)
      .pipe(
        Effect.filterOrFail(
          (response) => response.status === 101,
          (response) => new Error(`Live read upgrade answered ${response.status}`),
        ),
        Effect.retry(TRANSIT_RETRY),
        Effect.orDie,
      );
    // A fetched Response's headers are immutable; re-wrap the socket so
    // middleware (CORS, cookies) can still add headers to the upgrade.
    const body = response.body;
    if (body._tag === "Raw" && body.body instanceof Response) {
      const webSocket = (body.body as unknown as { readonly webSocket: unknown }).webSocket;
      if (webSocket) {
        return HttpServerResponse.raw(
          new Response(null, { status: 101, webSocket } as ResponseInit),
          { status: 101 },
        );
      }
    }
    return response;
  });

/** A step of the deploy's Workflow couldn't reach a consumer's class: this invocation runs older code. */
class Unreachable extends Data.TaggedError("Unreachable")<{ readonly message: string }> {}

/**
 * A Workflow step that reaches a consumer's class fails (rather than dies) when
 * the invocation runs code without it, and is tried a few times. A run started
 * on an edge that doesn't have the deployed code yet stays on that code: it
 * ends with this error, and the deploy starts it again (see `Backfill.ts`).
 */
const reachable = <A>(effect: Effect.Effect<A>) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.fail(new Unreachable({ message: Cause.pretty(cause) }))),
  );
const REACH_RETRIES = { limit: 3, delay: "1 second", backoff: "constant" } as const;

/**
 * The class a model's class takes over: the one it was named before Domain
 * version 0, when models in one Worker that listed the same definition shared
 * its class. A model that sets `legacyData: false` takes over nothing.
 */
const renamedFrom = (
  version: number | undefined,
  legacyData: boolean,
  legacyName: string,
): InlineDurableObjectProps =>
  version !== undefined && legacyData ? { renamedFrom: legacyName } : {};

/** The directory's class: before Domain versions, one for every model of a Worker. */
const DIRECTORY_CLASS = "DomainDirectory";

/** The model that keeps the directory from before Domain versions, per Worker. */
const directoryKeepers = new WeakMap<object, string>();

/**
 * The classes a route's objects may still be on when its model gets one class:
 * its version 0 class (`Billing.AccountAggregate`), and the class it was
 * before versions (`AccountAggregate`), which keeps its name. The deploy keeps
 * whichever the Worker has. A model that sets `legacyData: false` takes over
 * nothing from before versions. The directory from before versions was one
 * class for every model: the first model to list it keeps it. Two models that
 * take over any other class the Worker has fail the deploy (see
 * `AmbiguousDomainLegacyData`).
 */
const legacyClasses = Effect.fn(function* (
  modelName: string,
  route: string,
  legacyData: boolean,
  legacyName: string,
) {
  const current: LegacyClass = { className: route, binding: route };
  if (!legacyData) return [current];
  const before: LegacyClass = {
    className: legacyName,
    binding: `${route}${BEFORE_VERSIONS}`,
    beforeVersions: true,
  };
  // At runtime the bindings the upload kept decide (see `DomainClass.ts`).
  if (globalThis.__ALCHEMY_RUNTIME__) return [current, before];
  if (legacyName !== DIRECTORY_CLASS) return [current, before];
  const worker = yield* CloudflareWorker;
  const keeper = directoryKeepers.get(worker) ?? modelName;
  directoryKeepers.set(worker, keeper);
  return keeper === modelName ? [current, before] : [current];
});

/** A model's one class on the Worker, as `domainClass` hands it back. */
type SharedClass = Effect.Success<ReturnType<typeof domainClass>>;

/**
 * What Domain version 1 keeps of each model while its Layer is built: its
 * class, where its objects live (for the deploy's migration), and the class
 * each saga's runs move from.
 */
interface OneClass {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly shared: Map<string, SharedClass>;
  readonly layouts: Map<string, ModelLayout>;
  /** Each saga's class in version 0 (`Billing.ApproveWorkflow`): its model, its saga, and the class it was before versions. */
  readonly sagas: Map<
    string,
    {
      readonly modelName: string;
      readonly saga: string;
      readonly legacyData: boolean;
      readonly legacyName: string;
    }
  >;
}

/** The model's class, declared the first time and remembered for `lookup`. */
const sharedOf = (oneClass: OneClass, modelName: string) =>
  Effect.tap(domainClass(oneClass.random, modelName), (shared) =>
    Effect.sync(() => oneClass.shared.set(modelName, shared)),
  );

/**
 * Tell the Worker deploy that `route`'s old classes are kept only while
 * their objects move into the model's class: the deploy moves them between its
 * two uploads, then deletes each (see `DurableObjectRetirement`).
 */
const retiring = (
  modelName: string,
  route: string,
  legacy: ReadonlyArray<LegacyClass>,
  timeoutSeconds: number | undefined,
) =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.void
    : Effect.gen(function* () {
        const worker = yield* CloudflareWorker;
        const data: RetiringDomainClass = {
          route,
          domainClass: domainClassName(modelName),
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        };
        yield* worker.bind`${route}.Retiring`({
          retiringClasses: legacy.map(({ className, binding, beforeVersions }) => ({
            group: modelName,
            className,
            binding,
            data: { ...data, ...(beforeVersions ? { beforeVersions } : {}) },
          })),
        });
      });

/** For a plan: a route's old classes, and their retirement, are resources of its model. */
const ownLegacy = (modelName: string, route: string, legacy: ReadonlyArray<LegacyClass>) =>
  Effect.forEach(
    [...legacy.map((each) => each.binding), `${route}.Retiring`],
    (binding) => own("Model", modelName, binding),
    { discard: true },
  );

/**
 * A saga's run objects, listed in their model's directory as they start, like
 * every other object of the model: a later layout change finds each run
 * exactly. The workflow engine stays as it is; only `start` is wrapped.
 */
const listedRuns = (
  oneClass: OneClass,
  modelName: string,
  saga: string,
  impl: CloudflareImpl,
): CloudflareImpl =>
  Effect.map(impl, (make) =>
    Effect.gen(function* () {
      const instance = yield* make;
      const start = instance.start as
        | ((executionId: string, ...rest: ReadonlyArray<unknown>) => Effect.Effect<unknown>)
        | undefined;
      if (typeof start !== "function") return instance;
      const state = yield* DurableObjectState;
      const runtime = yield* RuntimeContext;
      return {
        ...instance,
        start: (executionId: string, ...rest: ReadonlyArray<unknown>) =>
          Effect.andThen(
            Effect.suspend(() => {
              const layout = oneClass.layouts.get(modelName);
              return layout === undefined
                ? Effect.void
                : layout
                    .register("Workflow", saga, executionId)
                    .pipe(Effect.provideService(ObjectState, objectState(state, runtime)));
            }),
            start(executionId, ...rest),
          ),
      };
    }),
  );

/** The Domain host over a Worker's Durable Objects. */
const cloudflareHost = (
  placement: Placement,
  /** How long a deploy waits for a backfill, in seconds. */
  backfillTimeoutSeconds: number | undefined,
  /** The Domain version to lay models out with: `undefined` for the layout from before versions. */
  version: number | undefined,
  legacySagas: Map<string, string>,
  /** The class each saga's runs live on, by its name before Domain version 0. */
  sagaRenames: Map<string, InlineDurableObjectProps>,
  /** Version 1: every object of a model in one class, `Billing.Domain` (see `DomainClass.ts`). */
  oneClass: OneClass | undefined,
  retention: Retention | undefined,
): Layer.Layer<Platform, never, Worker | SecureRandom.SecureRandom> =>
  Layer.unwrap(
    Effect.gen(function* () {
      /** A Durable Object namespace from the Worker's bindings, placed as the platform says. */
      const fromBinding = (native: any): CloudflareNamespace => {
        const wrap = (namespace: any): CloudflareNamespace => ({
          getByName: (name, options) => makeRpcStub(namespace.getByName(name, options)) as never,
          jurisdiction: (inside) => wrap(namespace.jurisdiction(inside)),
        });
        return placed(wrap(native), placement);
      };
      // The Worker's bindings, at runtime: see `lookup`.
      const env = Option.getOrUndefined(yield* Effect.serviceOption(WorkerEnvironment));
      /** A model's class name on the Worker: `Bank.AccountAggregate` (or the bare name before versions). */
      const named = (modelName: string, name: string) =>
        version === undefined ? name : className(modelName, name);
      const fromEnv = (
        workerEnv: Record<string, any> | undefined,
        binding: string,
      ): CloudflareNamespace | undefined => {
        const namespace = workerEnv?.[binding];
        return namespace !== undefined && typeof namespace.getByName === "function"
          ? fromBinding(namespace)
          : undefined;
      };
      /** A class of the model from the Worker's bindings: a route of its one class in version 1. */
      const classIn = (
        workerEnv: Record<string, any> | undefined,
        modelName: string,
        name: string,
      ): CloudflareNamespace | undefined => {
        if (oneClass === undefined) return fromEnv(workerEnv, named(modelName, name));
        const namespace = fromEnv(workerEnv, domainClassName(modelName));
        return namespace === undefined
          ? undefined
          : routeView(namespace, className(modelName, name));
      };
      const host: Host<Worker> = {
        // Every kind of object is declared through here, so none is left
        // outside the jurisdiction or the location hint.
        declare: ({ modelName, legacyData }, name, impl, runs) =>
          // For a plan: this object's class is a resource of the model, and
          // what it runs is listed under the piece's own binding.
          Effect.andThen(
            Effect.all(
              [
                own(
                  "Model",
                  modelName,
                  oneClass === undefined ? named(modelName, name) : domainClassName(modelName),
                ),
                runs === undefined
                  ? Effect.void
                  : hostedBy(
                      runs.kind,
                      runs.name,
                      oneClass === undefined ? named(modelName, name) : className(modelName, name),
                    ),
              ],
              { discard: true },
            ),
            oneClass === undefined
              ? Effect.map(
                  declare(
                    named(modelName, name),
                    renamedFrom(version, legacyData, name),
                    onCloudflare(impl),
                  ),
                  (namespace) => placed(namespace, placement),
                )
              : Effect.gen(function* () {
                  const shared = yield* sharedOf(oneClass, modelName);
                  const route = className(modelName, name);
                  // The old classes stay declared while their objects move over.
                  const legacy = yield* legacyClasses(modelName, route, legacyData, name);
                  yield* retiring(modelName, route, legacy, backfillTimeoutSeconds);
                  yield* ownLegacy(modelName, route, legacy);
                  const namespace = yield* shared.object(route, onCloudflare(impl), legacy);
                  return placed(namespace, placement);
                }),
          ),
        lookup: ({ modelName }, name) => {
          // A route this isolate's model hosts, or (code that doesn't build the model) any.
          const shared = oneClass?.shared.get(modelName);
          if (shared === undefined) return classIn(env, modelName, name);
          const view = shared.bound(className(modelName, name));
          return view === undefined ? undefined : placed(view, placement);
        },
        // How the deploy's migration finds every object of a model in version 1.
        layout: ({ modelName }, layout) =>
          oneClass === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const shared = yield* sharedOf(oneClass, modelName);
                oneClass.layouts.set(modelName, layout);
                const route = (name: string) => className(modelName, name);
                yield* shared.resolve({
                  namespace: placed(shared.namespace, placement),
                  directory: route(layout.directory),
                  entry: (ref) => {
                    const entry = layout.entry(ref);
                    if (entry !== undefined)
                      return { route: route(entry.name), source: entry.source };
                    // Saga runs: the engine declares their classes, not the platform.
                    const run = route(ref.source);
                    return shared.bound(run) === undefined
                      ? undefined
                      : { route: run, source: false };
                  },
                  consumer: (target) => {
                    const consumer = layout.consumer(target);
                    return { keys: route(consumer.keys), run: route(consumer.run) };
                  },
                  streams: (projection) => layout.streams(projection).map(route),
                  runs: () => layout.runs().map(route),
                  scanner: layout.scanner,
                });
              }),
        // Each saga's runs live on a Durable Object class of the workflow
        // engine, named after the model too.
        hosted: (model) =>
          Effect.sync(() => {
            for (const saga of model.sagas) {
              if (version === undefined) legacySagas.set(`${model.modelName}.${saga}`, saga);
              else if (oneClass !== undefined)
                oneClass.sagas.set(className(model.modelName, `${saga}Workflow`), {
                  modelName: model.modelName,
                  saga,
                  legacyData: model.legacyData,
                  legacyName: `${saga.replace(/[^A-Za-z0-9_]/g, "_")}Workflow`,
                });
              else
                sagaRenames.set(
                  className(model.modelName, `${saga}Workflow`),
                  renamedFrom(
                    version,
                    model.legacyData,
                    `${saga.replace(/[^A-Za-z0-9_]/g, "_")}Workflow`,
                  ),
                );
            }
          }),
        connect: connectTo,
        claimKey: CloudflareWorker,
        background: handToInvocation,
        // A deploy's backfill: a Workflow starts each new consumer's run, then
        // waits until every one is complete. Reconciliation starts it and waits.
        backfill: ({ modelName }, plansOf) =>
          Effect.gen(function* () {
            yield* own("Model", modelName, named(modelName, "DomainBackfill"));
            const backfill = yield* Workflow(
              named(modelName, "DomainBackfill"),
              Effect.succeed(
                (params: {
                  readonly targets: ReadonlyArray<string>;
                  readonly plans?: Readonly<Record<string, Backfill.Plan>>;
                }) =>
                  Effect.gen(function* () {
                    const plans = { ...plansOf(params.targets), ...params.plans };
                    const targets = params.targets.filter((target) => plans[target] !== undefined);
                    // This isolate doesn't build the model: reach each run's root by its binding.
                    const workerEnv = yield* WorkerEnvironment;
                    const root = (target: string) =>
                      Effect.suspend(() => {
                        const namespace = classIn(
                          workerEnv,
                          modelName,
                          runClass(
                            consumerClass(
                              Backfill.consumerOf(target).kind,
                              Backfill.consumerOf(target).name,
                              generationOfTarget(target),
                            ),
                          ),
                        );
                        return namespace === undefined
                          ? Effect.die(
                              new Error(`backfill: ${target} isn't in the code this runs yet`),
                            )
                          : Effect.succeed(namespace.getByName(RUN_ROOT));
                      });
                    for (const target of targets) {
                      const begun = yield* task(
                        `begin-${target}`,
                        reachable(
                          Effect.flatMap(root(target), (stub) =>
                            unwrapDefects<Backfill.Begin>(stub.bfRunBegin(target, plans[target]!)),
                          ),
                        ),
                        { retries: REACH_RETRIES },
                      );
                      // Started reading other sources: waiting on it would report a history
                      // that misses the new ones. The deploy fails, saying to bump the version.
                      if (begun.status === "changed")
                        return yield* Effect.die(
                          new Backfill.PlanChanged({
                            message: Backfill.planChanged(target, begun.started, plans[target]!),
                          }),
                        );
                    }
                    // Each check's output is the runs' progress: the deploy reads the latest one
                    // from the instance's steps, and reports it while it waits.
                    for (let check = 0; ; check++) {
                      const progress = yield* task(
                        `check-${check}`,
                        reachable(
                          Effect.forEach(targets, (target) =>
                            Effect.flatMap(root(target), (stub) =>
                              unwrapDefects<Backfill.Progress>(stub.bfRunProgress(target)),
                            ),
                          ),
                        ),
                        { retries: REACH_RETRIES },
                      );
                      if (progress.every((run) => run.phase === "complete"))
                        return { complete: true, progress };
                      yield* sleep(
                        `wait-${check}`,
                        // Soon at first, then less often: each check is a step (an instance has 10,000).
                        `${Math.min(5_000, Math.round(500 * 1.25 ** check))} millis`,
                      );
                    }
                  }),
              ) as unknown as Effect.Effect<WorkflowImpl<any, any, unknown>>,
            );
            return (targets: ReadonlyArray<string>) =>
              Effect.gen(function* () {
                const worker = yield* CloudflareWorker;
                yield* BackfillRun(named(modelName, "DomainBackfillRun"), {
                  scriptName: worker.workerName as unknown as string,
                  workflowName: backfill.workflowName as string,
                  targets: [...targets],
                  plans: plansOf(targets) as Record<
                    string,
                    { sources?: string[]; singleSource: boolean }
                  >,
                  ...(backfillTimeoutSeconds === undefined
                    ? {}
                    : { timeoutSeconds: backfillTimeoutSeconds }),
                }) as unknown as Effect.Effect<unknown>;
              });
          }),
      };
      return makePlatform(host, { retention: retention ?? {} });
    }),
  );

/**
 * Host a domain model on Cloudflare Durable Objects. Every aggregate, view
 * and policy becomes a Durable Object class on the host Worker, declared
 * while the model's Layer is built, so there are no bindings to write. One
 * instance per aggregate id, per view key, and per policy and source.
 *
 * Commands to one instance run one at a time, and their events, state and
 * outbox commit together. Deliveries to views and policies are at least once
 * and in order per source, and survive restarts. Live reads over
 * `Domain.protocolWebSocket` are WebSockets to the object that owns the key,
 * pushed on every commit; the object hibernates in between.
 *
 * A view or projection added in a later deploy receives the history recorded
 * before it, and the deploy waits until it has. Every instance lists itself in
 * a directory of Durable Objects; a run of new objects reads it, fans out six
 * ways, and gives each key of the new consumer its sources' events, which the
 * key applies in timestamp order.
 *
 * ### Hosting on Cloudflare
 * The Stack that deploys the Worker registers `DomainCloudflare.providers()`
 * next to `Cloudflare.providers()`, for the backfills its deploys wait on.
 *
 * **Example:** A Worker serving an Api
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 * import { CustomerApi } from "./CustomerApi.ts";
 * import { SessionLive } from "./Session.ts";
 *
 * const BankLive = SessionLive.pipe(
 *   Layer.provideMerge(Bank.layer(BankPolicies)),
 *   Layer.provide(DomainCloudflare.layerDurableObjects()),
 * );
 *
 * export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
 *   "BankWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* CustomerApi;
 *     return { fetch: api.fetch };
 *   }).pipe(Effect.provide(BankLive)),
 * ) {}
 * ```
 *
 * ### Restricting a model to a jurisdiction
 * **Example:** Every Durable Object of the model in the EU
 * ```typescript
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * const BankLive = Bank.layer(BankPolicies).pipe(
 *   Layer.provide(DomainCloudflare.layerDurableObjects({ jurisdiction: "eu" })),
 * );
 * ```
 *
 * ### Placing a model's Durable Objects
 * A Durable Object is created near the Worker that first reaches it, and
 * stays there. When the model's other dependencies sit in one region (the
 * database its projections write to, the Workers that call it), hint that
 * region instead.
 *
 * **Example:** Every new Durable Object of the model in western North America
 * ```typescript
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * const BankLive = Bank.layer(BankPolicies).pipe(
 *   Layer.provide(DomainCloudflare.layerDurableObjects({ locationHint: "wnam" })),
 * );
 * ```
 *
 * ### Hosting several models in one Worker
 * Each model gets its own Durable Object classes, named after the model
 * (`Billing.AccountAggregate`), so models that list the same aggregate never
 * share its data. A Worker deployed before Domain version 0 named a class
 * after its definition alone (`AccountAggregate`), shared by every model that
 * listed it; the next deploy moves its objects into the model's class. When
 * two models shared one, set `legacyData: false` on the `layer` of each model
 * that starts empty.
 *
 * **Example:** Two models that both list `Account`
 * ```typescript
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { Audit, AuditHandlers } from "./Audit.ts";
 * import { Billing, BillingHandlers } from "./Billing.ts";
 *
 * const Platform = DomainCloudflare.layerDurableObjects();
 * const BillingLive = Billing.layer(BillingHandlers).pipe(Layer.provide(Platform));
 * const AuditLive = Audit.layer(AuditHandlers).pipe(Layer.provide(Platform));
 * ```
 *
 * ### Keeping dedupe rows for a while
 * Receipts, policy delivery marks and cancelled scheduled commands exist only
 * to drop repeats. Each Durable Object deletes a few that are past their
 * window every time it commits.
 *
 * **Example:** Receipts for a year, delivery marks forever
 * ```typescript
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankPolicies } from "./Bank.ts";
 *
 * const BankLive = Bank.layer(BankPolicies).pipe(
 *   Layer.provide(
 *     DomainCloudflare.layerDurableObjects({
 *       retention: { receipts: "365 days", deliveries: "forever" },
 *     }),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export function layerDurableObjects({
  jurisdiction,
  locationHint,
  backfillTimeout,
  retention,
}: DurableObjectsOptions = {}): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine,
  never,
  Worker | SecureRandom.SecureRandom | Providers
> {
  const timeoutSeconds =
    backfillTimeout === undefined ? undefined : Duration.toSeconds(backfillTimeout);
  // The same options return the same Layer, so models that each provide it
  // share one platform and one workflow engine.
  const windows = retentionWindows(retention);
  const key = `${jurisdiction ?? ""}|${locationHint ?? ""}|${timeoutSeconds ?? ""}|${windows.receipts}|${windows.deliveries}|${windows.cancelled}`;
  const placement: Placement = { jurisdiction, locationHint };
  let platform = platforms.get(key);
  if (platform === undefined)
    platforms.set(
      key,
      (platform = Layer.unwrap(
        Effect.gen(function* () {
          const version = yield* DeployVersion;
          const sagaRenames = new Map<string, InlineDurableObjectProps>();
          const oneClass: OneClass | undefined =
            version !== undefined && version >= 1
              ? {
                  random: yield* SecureRandom.SecureRandom,
                  shared: new Map(),
                  layouts: new Map(),
                  sagas: new Map(),
                }
              : undefined;
          const engine = sagaEngine(placement, sagaRenames, oneClass, timeoutSeconds);
          const legacySagas = new Map<string, string>();
          return Layer.merge(
            cloudflareHost(
              placement,
              timeoutSeconds,
              version,
              legacySagas,
              sagaRenames,
              oneClass,
              retention,
            ),
            version === undefined ? legacyEngine(legacySagas).pipe(Layer.provide(engine)) : engine,
          );
        }),
      )),
    );
  // The Stack that deploys the Worker must register the providers too.
  return platform as Layer.Layer<
    Platform | WorkflowEngine.WorkflowEngine,
    never,
    Worker | SecureRandom.SecureRandom | Providers
  >;
}

/**
 * Effect's workflow engine on the Worker's Durable Objects, as
 * `Cloudflare.Workflows.layerDurableObjectEngine` runs it, with each saga's
 * class taking over the class its runs lived on before Domain version 0.
 */
const sagaEngine = (
  placement: Placement,
  sagaRenames: ReadonlyMap<string, InlineDurableObjectProps>,
  oneClass: OneClass | undefined,
  timeoutSeconds: number | undefined,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> =>
  makeDurableObjectEngine({
    declare: (name, impl) => {
      const cloudflareImpl = provideCallbacks(
        impl,
        DurableObjectCallbacks,
      ) as unknown as CloudflareImpl;
      // Version 1: a saga's runs are objects of its model's class too, on a route of their own.
      const saga = oneClass?.sagas.get(name);
      if (oneClass === undefined || saga === undefined)
        return Effect.map(declare(name, sagaRenames.get(name) ?? {}, cloudflareImpl), (namespace) =>
          placed(namespace, placement),
        );
      return Effect.gen(function* () {
        const shared = yield* sharedOf(oneClass, saga.modelName);
        const legacy = yield* legacyClasses(saga.modelName, name, saga.legacyData, saga.legacyName);
        yield* retiring(saga.modelName, name, legacy, timeoutSeconds);
        yield* ownLegacy(saga.modelName, name, legacy);
        const namespace = yield* shared.object(
          name,
          listedRuns(oneClass, saga.modelName, saga.saga, cloudflareImpl),
          legacy,
        );
        return placed(namespace, placement);
      });
    },
    state: DurableObjectState,
  });

/**
 * Before Domain version 0, a saga's runs lived on a class named after the
 * saga alone. Store each under that name, given by `legacySagas`.
 */
const legacyEngine = (
  legacySagas: ReadonlyMap<string, string>,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, WorkflowEngine.WorkflowEngine> =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const legacy: WorkflowEngine.WorkflowEngine["Service"] = {
        ...engine,
        register: (workflow, execute) => {
          const storageName = Context.getOrUndefined(workflow.annotations, StorageName);
          const legacyName = storageName === undefined ? undefined : legacySagas.get(storageName);
          return engine.register(
            legacyName === undefined
              ? workflow
              : Object.create(workflow, {
                  annotations: {
                    value: Context.add(workflow.annotations, StorageName, legacyName),
                    enumerable: true,
                  },
                }),
            execute,
          );
        },
      };
      return legacy;
    }),
  );

/** Options for {@link layerDurableObjects}. */
export interface DurableObjectsOptions {
  /**
   * Create and store every Durable Object of the model (aggregates, views,
   * policies, projections, streams and saga executions) only inside this
   * jurisdiction, e.g. `"eu"`.
   *
   * A Durable Object in a jurisdiction is a different object from the one
   * with the same name outside it. Setting this on a model that already has
   * data does not move that data: the model starts empty in the
   * jurisdiction, and the old objects are left as they were. Choose it before
   * the first deploy, or migrate deliberately.
   *
   * Like a D1 database, R2 bucket or Queue declared with a jurisdiction, it is
   * enforced when deployed and not emulated in `alchemy dev`: local workerd
   * does not implement jurisdictions, so the model runs unrestricted there.
   *
   * @default undefined (no jurisdiction restriction)
   */
  readonly jurisdiction?: DurableObjectJurisdiction;
  /**
   * Create every new Durable Object of the model (aggregates, views,
   * policies, projections, streams and saga executions) near this location,
   * e.g. `"wnam"`, instead of near the Worker that first reaches it.
   *
   * It only affects objects that do not exist yet: an object stays where it
   * was created, so setting or changing the hint does not move existing
   * ones. It is a hint, as on Cloudflare: an object is created in the
   * nearest location that can host it, which may not be the hinted one.
   * Unlike `jurisdiction`, it does not change which object a name refers to.
   *
   * Not emulated in `alchemy dev`, where every object runs on this machine.
   *
   * @default undefined (each object is created near its first request)
   */
  readonly locationHint?: DurableObjectLocationHint;
  /**
   * How long a deploy waits for the backfill of the views and projections it
   * adds or rebuilds. Past it the deploy fails with `BackfillStillRunning`,
   * naming how far each one has got, while the backfill keeps running on
   * Cloudflare: the next deploy waits on it again, from where it is.
   *
   * @default "30 minutes"
   */
  readonly backfillTimeout?: Duration.Input;
  /**
   * How long each Durable Object keeps the rows that only dedupe needs:
   * command and decision receipts, policy delivery marks, and cancelled
   * scheduled commands. An object deletes a few rows past their window each
   * time it commits, so an instance stops growing with its traffic.
   * `"forever"` keeps a kind of row.
   *
   * @default { receipts: "30 days", deliveries: "7 days", cancelled: "7 days" }
   */
  readonly retention?: Retention;
}

const platforms = new Map<
  string,
  Layer.Layer<Platform | WorkflowEngine.WorkflowEngine, never, Worker | SecureRandom.SecureRandom>
>();
