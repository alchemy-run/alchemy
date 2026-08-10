/**
 * Shared scaffolding for the per-cloud **deploy wrappers**
 * (`Cloudflare.Worker(cls, props, implOrDefinition)`, `Celld.Worker(...)`,
 * `Rivet.Worker(...)`).
 *
 * A deploy wrapper turns a cloud-free worker definition into that cloud's
 * NATIVE worker resource:
 *
 * 1. resolve the impl (an impl Effect, or the definition marker
 *    `cls.make(impl)` produced);
 * 2. provide the per-cloud {@link WorkerTarget} adapter and a SELF
 *    {@link HostRef} around the impl, and apply the target's `wrapServe`
 *    to the returned `fetch` (identically on plan and runtime
 *    evaluations);
 * 3. hand the wrapped impl to the cloud's native worker platform — which
 *    owns exports, Durable Object class migrations, bundling, and the
 *    whole deployment lifecycle;
 * 4. return a Layer providing the portable class tag (value = the native
 *    resource) plus the keyed {@link Deployment} proof its `.ref`
 *    companion consumes.
 *
 * @internal consumed by the per-cloud deploy modules, not by user code.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Deployment,
  HostRef,
  WorkerTarget,
  type HostRefService,
  type WorkerTargetService,
} from "./Engine.ts";
import {
  resolveWorkerRef,
  workerConnectionKeys,
  type WorkerRef,
} from "./DurableObject.ts";
import { isWorkerDefinition, workerSelf } from "./Worker.ts";

/**
 * Resolve a deploy wrapper's third argument into the impl effect:
 * an impl Effect directly, the definition marker `cls.make(impl)`
 * produced, or (for the inline class form) the impl stored on the class.
 */
export const resolveDeployImpl = (
  cls: unknown,
  layerOrImpl: unknown,
): Effect.Effect<any, any, any> => {
  if (Effect.isEffect(layerOrImpl)) {
    return layerOrImpl as Effect.Effect<any, any, any>;
  }
  if (isWorkerDefinition(layerOrImpl)) {
    return layerOrImpl.impl;
  }
  const inline = (cls as { impl?: unknown })?.impl;
  if (layerOrImpl === undefined && Effect.isEffect(inline)) {
    return inline as Effect.Effect<any, any, any>;
  }
  throw new Error(
    "A deploy wrapper takes the worker impl — pass the impl Effect " +
      "directly, or the definition produced by `cls.make(impl)`.",
  );
};

export interface WorkerDeployAdapter<K extends string> {
  /** The platform kind (`"cloudflare"`, `"celld"`, `"rivet"`). */
  readonly kind: K;
  /** The per-cloud adapter provided around the impl. */
  readonly target: WorkerTargetService;
  /**
   * The deploy-time caller binding a `.ref` (and the self host-ref)
   * carries — absorbed from the deleted engine seam.
   */
  readonly callerBinding: (clsId: string) => HostRefService["callerBinding"];
  /**
   * Construct the NATIVE worker for this deployment: the platform-make
   * layer (which must provide the root `Self` hierarchy so the runtime
   * bridges resolve the entrypoint) and an effect resolving the native
   * resource instance from that layer's context.
   */
  readonly makeNative: (
    clsId: string,
    props: any,
    impl: Effect.Effect<any, any, any>,
  ) => {
    readonly layer: Layer.Layer<any, any, any>;
    readonly instance: Effect.Effect<any, any, any>;
  };
}

export const makeWorkerDeploy = <K extends string>(
  adapter: WorkerDeployAdapter<K>,
) => {
  const makeCallerRef = (clsId: string) => ({
    kind: adapter.kind,
    workerId: clsId,
    ...workerConnectionKeys(clsId),
    remoteDurableObject: adapter.target.remoteDurableObject,
    callerBinding: adapter.callerBinding(clsId),
  });

  const deployWorker = (
    cls: WorkerRef,
    props: any,
    layerOrImpl: unknown,
  ): Layer.Layer<any, any, any> => {
    const clsId = resolveWorkerRef(cls).LogicalId;
    const impl = resolveDeployImpl(cls, layerOrImpl);
    const selfRef: HostRefService = {
      ...makeCallerRef(clsId),
      // Never read on the hosting path (dispatch compares ids and hosts);
      // present so foreign-DO layers piped with their own ref are
      // unaffected.
      worker: undefined,
    };
    // Provide the target + self host-ref around the impl, and apply the
    // target's gateway wrap to the returned `fetch`. The wrap must run on
    // BOTH plan and runtime evaluations — this mapping is part of the
    // deploy module, which re-executes inside the bundle.
    const wrappedImpl = Effect.gen(function* () {
      const shape = ((yield* impl) ?? {}) as Record<string, unknown>;
      return adapter.target.wrapServe !== undefined
        ? { ...shape, fetch: adapter.target.wrapServe(shape.fetch as any) }
        : shape;
    }).pipe(
      Effect.provideService(WorkerTarget, adapter.target),
      Effect.provideService(HostRef, selfRef),
    );

    const native = adapter.makeNative(clsId, props, wrappedImpl);
    // The portable class tag resolves the NATIVE resource — `yield* Api`
    // in the stack effect gives the deployed worker (URL and all).
    const portableTag = Layer.effect(
      workerSelf(clsId) as any,
      native.instance as Effect.Effect<any, never, never>,
    );
    const deployed = portableTag.pipe(Layer.provideMerge(native.layer));
    const deployment = Layer.effect(
      Deployment<any, K>(adapter.kind, clsId),
      Effect.gen(function* () {
        // Inside the deployed worker the entry rebuilds this layer, but
        // the Deployment proof belongs to plan time. Nothing consumes it
        // at runtime; refs guard themselves.
        if (globalThis.__ALCHEMY_RUNTIME__) {
          return { kind: adapter.kind, worker: undefined };
        }
        const worker = yield* workerSelf(clsId) as any;
        return { kind: adapter.kind, worker };
      }),
    );
    return deployment.pipe(Layer.provideMerge(deployed));
  };

  /**
   * Assert — and prove — that `cls` is deployed to this platform,
   * yielding the platform-agnostic {@link HostRef} a binder requires.
   * Only this platform's deploy module for this worker can discharge the
   * `Deployment` requirement, so a binder pointed at a worker hosted
   * elsewhere fails to compile.
   */
  const workerRef = (cls: WorkerRef): Layer.Layer<HostRef, never, any> =>
    Layer.effect(
      HostRef,
      Effect.gen(function* () {
        const clsId = resolveWorkerRef(cls).LogicalId;
        const base = makeCallerRef(clsId);
        // Inside the deployed caller the layer stack re-executes, but the
        // stack-scoped Deployment proof is a plan-time construct — the
        // connection material arrives via the bound env instead.
        if (globalThis.__ALCHEMY_RUNTIME__) {
          return { ...base, worker: undefined };
        }
        const deployment = yield* Deployment<any, K>(adapter.kind, clsId);
        return { ...base, worker: deployment.worker };
      }),
    ) as Layer.Layer<HostRef, never, any>;

  return { deployWorker, workerRef };
};
