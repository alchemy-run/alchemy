import { outsideAlarmPass } from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import {
  DurableObject as CloudflareDurableObject,
  type DurableObjectGetDurableObjectOptions,
  type DurableObjectJurisdiction,
  type DurableObjectLocationHint,
  type InlineDurableObjectProps,
} from "@alchemy.run/cloudflare/Workers/DurableObject";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import { makeRpcStub } from "@alchemy.run/cloudflare/Workers/Rpc";
import { upgrade } from "@alchemy.run/cloudflare/Workers/WebSocket";
import { Worker as CloudflareWorker, type Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerEnvironment } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import {
  sleep,
  task,
  Workflow,
  type WorkflowImpl,
} from "@alchemy.run/cloudflare/Workflows/Workflow";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine } from "alchemy/Workers/DurableObjectEngine";
import { StorageName } from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { WorkflowEngine } from "effect/workflow";
import * as Backfill from "../Backfill.ts";
import {
  Attachment,
  className,
  consumerClass,
  generationOfTarget,
  type Host,
  makePlatform,
  type Namespace,
  type ObjectImpl,
  ObjectState,
  type ObjectStateShape,
  RUN_ROOT,
  type Stub,
  runClass,
  SUBSCRIPTION_HEADER,
  TRANSIT_RETRY,
  unwrapDefects,
} from "../DurableObjects.ts";
import { type Platform, type Subscription } from "../Platform.ts";
import { Backfill as BackfillRun } from "./Backfill.ts";
import type { Providers } from "./Providers.ts";
import { DeployVersion } from "./Version.ts";

export { Backfill, BackfillFailed, BackfillStillRunning } from "./Backfill.ts";
export { providers, Providers, type ProviderRequirements } from "./Providers.ts";

/** A Cloudflare Durable Object namespace: Domain's, plus fetch, jurisdictions and placement. */
interface CloudflareNamespace extends Namespace {
  readonly getByName: (
    name: string,
    options?: DurableObjectGetDurableObjectOptions,
  ) => Stub & {
    readonly fetch: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>;
  };
  readonly jurisdiction: (jurisdiction: DurableObjectJurisdiction) => CloudflareNamespace;
}

/** What a Cloudflare instance's methods and constructor run with. */
type InstanceServices = DurableObjectState | RuntimeContext | Scope.Scope;

/** The usual outer (construction) / inner (instance) pair. */
type CloudflareImpl = Effect.Effect<
  Effect.Effect<Record<string, unknown>, never, InstanceServices>,
  never,
  DurableObjectState
>;

/**
 * Declare a Durable Object class on the host Worker from inside a factory.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
const declare = CloudflareDurableObject as unknown as (
  name: string,
  props: InlineDurableObjectProps,
  impl: CloudflareImpl,
) => Effect.Effect<CloudflareNamespace, never, Worker>;

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

/** Domain's view of a Cloudflare Durable Object's state. */
const objectState = (
  state: DurableObjectState["Service"],
  runtime: RuntimeContext["Service"],
): ObjectStateShape => ({
  storage: state.storage as unknown as ObjectStateShape["storage"],
  // Durable Objects run each event in its own I/O context, so in-memory
  // coordination across events is unsafe; the platform's gate is not.
  exclusive: (effect) =>
    Effect.flatMap(
      state.blockConcurrencyWhile(() => Effect.exit(effect)),
      (exit) => exit,
    ).pipe(Effect.provideService(RuntimeContext, runtime)),
  // Background work outside the alarm pass, so a callback's alarm isn't held open by it.
  waitUntil: (effect) =>
    state.waitUntil(outsideAlarmPass(effect)).pipe(Effect.provideService(RuntimeContext, runtime)),
  sockets: {
    accept: () =>
      Effect.provideService(upgrade(), DurableObjectState, state) as unknown as ReturnType<
        NonNullable<ObjectStateShape["sockets"]>["accept"]
      >,
    all: () =>
      state.getWebSockets() as unknown as ReturnType<
        NonNullable<ObjectStateShape["sockets"]>["all"]
      >,
  },
});

/** Run a Domain object on a Cloudflare Durable Object class. */
const onCloudflare = (impl: ObjectImpl): CloudflareImpl =>
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const runtime = yield* RuntimeContext;
      return yield* impl.pipe(Effect.provideService(ObjectState, objectState(state, runtime)));
    }),
  );

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
      const host: Host<Worker> = {
        // Every kind of object is declared through here, so none is left
        // outside the jurisdiction or the location hint.
        declare: ({ modelName, legacyData }, name, impl) =>
          Effect.map(
            declare(
              named(modelName, name),
              renamedFrom(version, legacyData, name),
              onCloudflare(impl),
            ),
            (namespace) => placed(namespace, placement),
          ),
        lookup: ({ modelName }, name) => fromEnv(env, named(modelName, name)),
        // Each saga's runs live on a Durable Object class of the workflow
        // engine, named after the model too.
        hosted: (model) =>
          Effect.sync(() => {
            for (const saga of model.sagas) {
              if (version === undefined) legacySagas.set(`${model.modelName}.${saga}`, saga);
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
        // A deploy's backfill: a Workflow starts each new consumer's run, then
        // waits until every one is complete. Reconciliation starts it and waits.
        backfill: ({ modelName }, plansOf) =>
          Effect.gen(function* () {
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
                        const namespace = fromEnv(
                          workerEnv,
                          named(
                            modelName,
                            runClass(
                              consumerClass(
                                Backfill.consumerOf(target).kind,
                                Backfill.consumerOf(target).name,
                                generationOfTarget(target),
                              ),
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
      return makePlatform(host);
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
 * listed it; the next deploy renames it to the model's class with
 * `renamedFrom`, keeping its objects. When two models shared one, set
 * `legacyData: false` on the `layer` of each model that starts empty.
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
 * @layer
 * @provides Domain.Platform
 * @provides WorkflowEngine
 */
export function layerDurableObjects({
  jurisdiction,
  locationHint,
  backfillTimeout,
}: DurableObjectsOptions = {}): Layer.Layer<
  Platform | WorkflowEngine.WorkflowEngine,
  never,
  Worker | SecureRandom.SecureRandom | Providers
> {
  const timeoutSeconds =
    backfillTimeout === undefined ? undefined : Duration.toSeconds(backfillTimeout);
  // The same options return the same Layer, so models that each provide it
  // share one platform and one workflow engine.
  const key = `${jurisdiction ?? ""}|${locationHint ?? ""}|${timeoutSeconds ?? ""}`;
  const placement: Placement = { jurisdiction, locationHint };
  let platform = platforms.get(key);
  if (platform === undefined)
    platforms.set(
      key,
      (platform = Layer.unwrap(
        Effect.gen(function* () {
          const version = yield* DeployVersion;
          const sagaRenames = new Map<string, InlineDurableObjectProps>();
          const engine = sagaEngine(placement, sagaRenames);
          const legacySagas = new Map<string, string>();
          return Layer.merge(
            cloudflareHost(placement, timeoutSeconds, version, legacySagas, sagaRenames),
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
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> =>
  makeDurableObjectEngine({
    declare: (name, impl) =>
      Effect.map(
        declare(name, sagaRenames.get(name) ?? {}, impl as unknown as CloudflareImpl),
        (namespace) => placed(namespace, placement),
      ),
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
}

const platforms = new Map<
  string,
  Layer.Layer<Platform | WorkflowEngine.WorkflowEngine, never, Worker | SecureRandom.SecureRandom>
>();
