/**
 * The compile-time seam between the portable `Alchemy.Worker` /
 * `Alchemy.DurableObject` authoring surface and the platform a worker
 * actually deploys to.
 *
 * There is no deploy-time dispatch here: a deploy wrapper
 * (`Cloudflare.Worker(cls, props, impl)`, `Celld.Worker(...)`,
 * `Rivet.Worker(...)`) constructs its cloud's NATIVE worker resource
 * directly — the hosting machinery itself is the native Durable Object
 * core (see `Cloudflare/Workers/DurableObject.ts`), with per-engine
 * variation riding on the host's runtime context. What remains portable
 * is purely contractual:
 *
 * - **{@link Deployment}** — the keyed proof that a worker is deployed to
 *   a specific platform, produced by the deploy wrapper and consumed by
 *   that platform's `.ref` constructor.
 *
 * - **{@link HostRef}** — the platform-agnostic resolved reference a
 *   caller binds to, carrying identity, connection env keys, the remote
 *   Durable Object transport, and the deploy-time caller binding.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ResourceLike } from "../Resource.ts";

/** A named Durable Object namespace client (see `Worker/DurableObject.ts`). */
export interface DurableObjectNamespaceClient {
  getByName: (name: string) => any;
}

/**
 * The portable worker's binding contract. `grants` is the host-mediated
 * permission channel, extended per platform substrate via module
 * augmentation (an AWS-substrate host registers `policyStatements`).
 */
export interface WorkerBindingContract {
  env?: Record<string, any>;
  durableObjects?: { name: string; className: string }[];
  grants?: Record<string, unknown>[];
}

/**
 * Proof that a worker is deployed to a specific platform — produced by a
 * deploy module (`Cloudflare.Worker(cls, props, impl)`) and required by
 * that platform's {@link HostRef} constructor (`Cloudflare.Worker.ref(cls)`).
 *
 * `K` is a TYPE parameter, not merely runtime data: it is what makes
 * `api/rivet.ts` + `Cloudflare.Worker.ref(Api)` a compile error rather
 * than a silent HTTP hop. Per-worker distinctness comes from `W` — two
 * tag-constructor calls produce the same type unless their type arguments
 * differ, so the string key below matters only at runtime.
 */
export interface DeploymentService<W, K extends string> {
  /** The platform kind that deployed the worker. */
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
export interface HostRefService<W = unknown> {
  /** The platform kind hosting the referenced worker. */
  readonly kind: string;
  /** The referenced worker's logical id. */
  readonly workerId: string;
  /** The referenced worker's resource handle (attribute Outputs). */
  readonly worker: W;
  /** Standard env key the worker's URL is bound under. */
  readonly urlKey: string;
  /** Standard env key the worker's secret is bound under. */
  readonly secretKey: string;
  /**
   * The remote Durable Object transport for the hosting platform — builds
   * the namespace client a REMOTE caller (an AWS Lambda, an ECS task) uses
   * to reach this platform's Durable Objects, from the connection material
   * the ref's `callerBinding` bound into the caller's environment. Rides
   * on the ref because each `.ref` names its cloud statically — deploy
   * layers are absent from a deployed caller's bundle, so nothing can be
   * looked up at runtime, and a caller that forgets the ref fails to
   * COMPILE.
   */
  readonly remoteDurableObject: (options: {
    readonly url: string;
    readonly secret: string;
    readonly namespace: string;
  }) => DurableObjectNamespaceClient;
  /**
   * The deploy-time half of connecting a caller host (Lambda Function, ECS
   * task, …) to the referenced worker: return the binding data the caller
   * needs — the worker's URL + secret under the provided STANDARD env
   * keys, plus any platform-specific fragments (network attachment,
   * credentials). The runtime half is platform-neutral: callers speak the
   * transport above against the bound URL.
   */
  readonly callerBinding: (options: {
    /** The deployed worker's resource handle (attribute Outputs). */
    readonly worker: any;
    /** The caller host resource the binding lands on. */
    readonly host: ResourceLike;
    /** Standard env key the worker's URL must be bound under. */
    readonly urlKey: string;
    /** Standard env key the worker's secret must be bound under. */
    readonly secretKey: string;
  }) => Effect.Effect<Record<string, unknown>, any, any>;
}

/**
 * The host-reference tag. A SINGLE well-known tag rather than a keyed
 * family: within one DO layer's provide chain there is exactly one host
 * (each `CounterLive.pipe(Layer.provide(X.Worker.ref(W)))` scopes its own),
 * so no runtime key is needed — stack-level distinctness lives on the
 * keyed {@link Deployment} instead.
 */
export class HostRef extends Context.Service<HostRef, HostRefService>()(
  "Alchemy.WorkerHostRef",
) {}
