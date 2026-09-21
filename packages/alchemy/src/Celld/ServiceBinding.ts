import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { getRefMetadata, isRef } from "../Ref.ts";
import { isResourceOfType } from "../Resource.ts";
import { WorkerEnvironment } from "../Workers/Worker.ts";
import {
  fromNativeFetcher,
  type Fetcher,
  type NativeFetcher,
} from "./Fetcher.ts";
import { storageBinding } from "./KV/StorageBinding.ts";
import type { CelldWorker } from "./Worker.ts";

/** Native environment naming for a service binding. */
export interface ServiceBindingOptions {
  /** Defaults to the target's LogicalId. Use an alias for targets with the same logical ID. */
  bindingName?: string;
}

/** A fetch-only service client; no native RPC, connect or stub transfer surface. */
export type ServiceFetch = Fetcher["fetch"];

export interface Fetch extends Binding.Service<
  Fetch,
  "Celld.Fetch",
  (
    worker: CelldWorker,
    options?: ServiceBindingOptions,
  ) => Effect.Effect<ServiceFetch>
> {}

/**
 * Fetch another Worker through a native Celld service binding on the same fleet.
 * Like Cloudflare's Fetch capability, binding returns a callable fetch function.
 * Both Effect HTTP client requests and server-request forwarding are supported.
 * The generated Effect Worker bridge does not export native RPC methods; this
 * capability deliberately exposes fetch only and never uses the operator API.
 *
 * ### Call a service
 * **Example:** Forward a request from another Worker
 * ```typescript
 * const fetchApi = yield* Celld.Fetch(api);
 * return { fetch: Effect.gen(function* () {
 *   const request = yield* HttpServerRequest;
 *   return yield* fetchApi(request);
 * }) };
 * ```
 * Provide `Celld.FetchBinding` on the caller Worker's initialization effect.
 *
 * @binding
 * @product Celld
 * @category Workers & Compute
 */
export const Fetch = Binding.Service<Fetch>("Celld.Fetch");

const isWorker = (value: unknown): value is CelldWorker =>
  isResourceOfType(value, "Celld.Worker");

/**
 * Implement Fetch with a native service binding and deploy-time fleet validation.
 * The Worker environment is captured at initialization; its fetcher is looked up
 * only when the returned client is called in a request.
 *
 * @layer
 * @provides Celld.Fetch
 * @product Celld
 */
export const FetchBinding = Layer.effect(
  Fetch,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    return Effect.fn(function* (
      worker: CelldWorker,
      options?: ServiceBindingOptions,
    ) {
      const name = options?.bindingName ?? worker.LogicalId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isWorker(host)) {
          const resource = Output.isOutput(worker)
            ? Output.isRefExpr(worker)
              ? worker.resourceId
              : worker.FQN
            : isRef(worker)
              ? getRefMetadata(worker).id
              : worker.FQN;
          yield* host.bind`service:${worker}:${name}`({
            bindings: [{ type: "service", name, service: worker.workerName }],
            storageBindings: [{ ...storageBinding(worker), resource }],
          });
        }
      }
      return fromNativeFetcher({
        fetch: (request, init) => {
          const native = env[name] as NativeFetcher | undefined;
          if (!native || typeof native.fetch !== "function")
            throw new Error(`Missing Celld service binding '${name}'`);
          return native.fetch(request, init);
        },
      }).fetch;
    });
  }),
);
