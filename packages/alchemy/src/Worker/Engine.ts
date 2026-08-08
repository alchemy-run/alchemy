/**
 * The extension seam between the portable `Alchemy.Worker` /
 * `Alchemy.DurableObject` authoring surface and the platform a worker
 * actually deploys to.
 *
 * Two services, mirroring the `Kubernetes.ClusterAdapter` /
 * `Celld.FleetHost` pattern:
 *
 * - **{@link WorkerTarget}** — provided INSIDE the worker impl's own
 *   `Effect.provide` chain by a target constructor (e.g.
 *   `Celld.Worker({ fleet, main })`). It carries the engine kind, the
 *   resolved deployment props, and the engine-side behaviors the runtime
 *   context needs at bundle-assembly time. Because capability binding
 *   layers require host services only their matching target provides,
 *   putting the target in the impl's provide chain makes
 *   engine/capability mismatches a COMPILE error at `Api.make(impl)`.
 *
 * - **{@link WorkerEngine}** — a keyed Context tag
 *   (`Alchemy.WorkerEngine/<kind>`) resolved dynamically from the ambient
 *   provider context. The engine owns the deployment lifecycle for
 *   `Alchemy.Worker` resources targeted at it, plus how callers outside
 *   the worker connect to its Durable Objects. Cloud provider layers
 *   contribute engines (`Celld.providers()` registers `celld`).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { HttpEffect } from "../Http.ts";
import type { ResourceBinding, ResourceLike } from "../Resource.ts";

/** A named Durable Object namespace client (see `Worker/DurableObject.ts`). */
export interface DurableObjectNamespaceClient {
  getByName: (name: string) => any;
}

/**
 * The value a target layer provides inside the worker impl's provide chain.
 * `props` is folded onto the worker resource's Props post-init (the engine's
 * provider reads it back at reconcile).
 */
export interface WorkerTargetService {
  /** The engine kind this target deploys through (keys the engine lookup). */
  readonly kind: string;
  /**
   * Engine-specific deployment props, resolved by the target constructor
   * (may carry Outputs of other resources — deep `Input` resolution turns
   * them into plain values by reconcile).
   */
  readonly props: Record<string, unknown>;
  /**
   * Wrap the worker's served `fetch` handler at bundle-assembly time (e.g.
   * celld's authenticated RPC gateway). Applied on BOTH plan and runtime
   * evaluations of the impl.
   */
  readonly wrapServe?: (
    handler: HttpEffect<any> | undefined,
  ) => HttpEffect<any>;
  /**
   * Build the namespace client for a Durable Object hosted by THIS worker,
   * from the runtime environment's native binding (e.g. celld wraps the
   * native stub with the fetch-RPC transport; a Cloudflare engine would use
   * the JSRPC stub).
   */
  readonly localDurableObject: (
    nativeBinding: any,
    namespace: string,
  ) => DurableObjectNamespaceClient;
  /**
   * Build the namespace client a REMOTE caller (an AWS Lambda, an ECS task)
   * uses to reach this engine's Durable Objects, from the connection
   * material the engine's `callerBinding` bound into the caller's
   * environment.
   *
   * This lives on the TARGET rather than the engine deliberately. Engines
   * are deploy-time provider layers and do not exist inside a deployed
   * caller's bundle, so resolving the protocol through
   * {@link findWorkerEngine} at runtime would typecheck and then die in
   * production. The target layer is provided in the caller's own
   * `Effect.provide` chain, so it is present in both phases — and a caller
   * that forgets it fails to COMPILE.
   *
   * Engines differ here: celld and Cloudflare serve alchemy's fetch-RPC on
   * the worker gateway (`POST {url}/{ns}/{instance}/__rpc__/{method}`);
   * Rivet speaks its own gateway protocol.
   */
  readonly remoteDurableObject: (options: {
    readonly url: string;
    readonly secret: string;
    readonly namespace: string;
  }) => DurableObjectNamespaceClient;
}

export class WorkerTarget extends Context.Service<
  WorkerTarget,
  WorkerTargetService
>()("Alchemy.WorkerTarget") {}

/**
 * The generic worker's binding contract. `grants` is the host-mediated
 * permission channel, extended per engine substrate via module
 * augmentation (an AWS-substrate engine registers `policyStatements`).
 */
export interface WorkerBindingContract {
  env?: Record<string, any>;
  durableObjects?: { name: string; className: string }[];
  grants?: Record<string, unknown>[];
}

export interface WorkerEngineService {
  readonly kind: "Alchemy.WorkerEngine";
  /**
   * Deployment lifecycle for `Alchemy.Worker` resources targeted at this
   * engine. Signatures mirror the provider's — the generic WorkerProvider
   * dispatches to these per the resource's stamped target kind.
   */
  readonly reconcile: (input: {
    id: string;
    news: Record<string, any>;
    olds: Record<string, any> | undefined;
    output: Record<string, any> | undefined;
    session: { note: (message: string) => Effect.Effect<void> };
    bindings: ResourceBinding<WorkerBindingContract>[];
  }) => Effect.Effect<Record<string, any>, any, any>;
  readonly delete: (input: {
    id: string;
    olds: Record<string, any>;
    output: Record<string, any>;
  }) => Effect.Effect<void, any, any>;
  readonly diff?: (input: {
    id: string;
    news: any;
    output: Record<string, any> | undefined;
  }) => Effect.Effect<{ action: "update" | "replace" } | undefined, any, any>;
  /**
   * The deploy-time half of connecting a caller host (Lambda Function, ECS
   * task, …) to a worker deployed through this engine: return the binding
   * data the caller needs — the worker's URL + secret under the provided
   * STANDARD env keys, plus any engine-specific fragments (network
   * attachment, credentials). The runtime half is engine-neutral: callers
   * speak the alchemy fetch-RPC protocol against the bound URL.
   */
  readonly callerBinding: (options: {
    /** The `Alchemy.Worker` resource instance (attribute Outputs). */
    readonly worker: any;
    /** The caller host resource the binding lands on. */
    readonly host: ResourceLike;
    /** Standard env key the worker's URL must be bound under. */
    readonly urlKey: string;
    /** Standard env key the worker's secret must be bound under. */
    readonly secretKey: string;
  }) => Effect.Effect<Record<string, unknown>, any, any>;
}

const ENGINE_PREFIX = "Alchemy.WorkerEngine/";

/** The keyed Context tag for a worker engine. */
export const WorkerEngine = (
  kind: string,
): Context.Service<WorkerEngineService, WorkerEngineService> =>
  Context.Service<WorkerEngineService, WorkerEngineService>()(
    `${ENGINE_PREFIX}${kind}`,
  ) as any;

/**
 * Resolve the {@link WorkerEngineService} for an engine kind from the
 * ambient context (the stack's composed provider layers). Dies with setup
 * guidance when the contributing provider layer is missing.
 */
export const findWorkerEngine = (
  kind: string | undefined,
): Effect.Effect<WorkerEngineService> =>
  kind === undefined
    ? Effect.die(
        new Error(
          "This Alchemy.Worker has no deployment target. Provide one " +
            "inside the impl's layer stack — e.g. " +
            "`impl.pipe(Effect.provide(Celld.Worker({ fleet, main })))`.",
        ),
      )
    : Effect.serviceOption(WorkerEngine(kind)).pipe(
        Effect.flatMap((option) =>
          option._tag === "Some"
            ? Effect.succeed(option.value)
            : Effect.die(
                new Error(
                  `No worker engine is registered for kind '${kind}'. Add ` +
                    "the provider layer that contributes it to the stack's " +
                    "providers — e.g. 'celld' ships with `Celld.providers()`.",
                ),
              ),
        ),
      );

/**
 * Proof that a worker is deployed to a specific platform — produced by a
 * deploy module (`Cloudflare.Worker(props, ApiLive)`) and required by that
 * platform's {@link HostRef} constructor (`Cloudflare.Worker.ref(Api)`).
 *
 * `K` is a TYPE parameter, not merely runtime data: it is what makes
 * `api/rivet.ts` + `Cloudflare.Worker.ref(Api)` a compile error rather
 * than a silent HTTP hop. Per-worker distinctness comes from `W` — two
 * tag-constructor calls produce the same type unless their type arguments
 * differ, so the string key below matters only at runtime.
 */
export interface DeploymentService<W, K extends string> {
  /** The engine kind that deployed the worker. */
  readonly kind: K;
  /** The deployed worker's resource handle (attribute Outputs). */
  readonly worker: W;
}

/** Build the keyed deployment tag for one worker on one platform. */
export const Deployment = <W, K extends string>(kind: K, logicalId: string) =>
  Context.Service<DeploymentService<W, K>, DeploymentService<W, K>>()(
    `Alchemy.WorkerDeployment/${kind}/${logicalId}`,
  );

/**
 * A resolved reference to a worker a caller binds to — deliberately
 * platform-AGNOSTIC, so a definition module (`web/worker.ts`) can require
 * it without naming a cloud. The platform-specific obligation lives on
 * {@link Deployment}, which the `.ref` constructor consumes to produce
 * this; that split is what keeps definition modules cloud-free while the
 * proof still propagates to the stack.
 */
export interface HostRefService<W> {
  /** The engine kind hosting the referenced worker. */
  readonly kind: string;
  /** The referenced worker's resource handle (attribute Outputs). */
  readonly worker: W;
  /** Standard env key the worker's URL is bound under. */
  readonly urlKey: string;
  /** Standard env key the worker's secret is bound under. */
  readonly secretKey: string;
}

/** Build the keyed host-reference tag for one worker. */
export const HostRef = <W>(logicalId: string) =>
  Context.Service<HostRefService<W>, HostRefService<W>>()(
    `Alchemy.WorkerHostRef/${logicalId}`,
  );
