import { RuntimeError } from "@distilled.cloud/cloudflare-runtime/RuntimeError";
import * as Worker from "@distilled.cloud/cloudflare-runtime/Worker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BundleError } from "../../Bundle/Bundle.ts";
import * as RpcClient from "../../Sidecar/RpcClient.ts";
import { defineSchema } from "../../Sidecar/RpcHandler.ts";
import type { WorkerBinding } from "../Workers/Worker.ts";
import type { WorkerBundleOptions } from "../Workers/WorkerBundle.ts";

export interface ServeOptions extends WorkerBundleOptions {
  name: string;
  bindings: WorkerBinding[];
  /**
   * Local-mode hyperdrive connection details, keyed by binding name.
   * Forwarded to the runtime as the worker's `hyperdrives` field.
   */
  hyperdrives?: Record<string, Worker.HyperdriveOrigin>;
  durableObjectNamespaces: Worker.DurableObjectNamespace[];
}

export const ServeResult = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
});
export type ServeResult = typeof ServeResult.Type;

export const ServeError = Schema.Union([RuntimeError, BundleError]);
export type ServeError = typeof ServeError.Type;

export const SidecarSchema = defineSchema<Sidecar["Service"]>({
  serve: {
    success: ServeResult,
    error: ServeError,
  },
  stop: { success: Schema.Void, error: Schema.Never },
});

export class Sidecar extends RpcClient.RpcClientService<
  Sidecar,
  {
    readonly serve: (
      options: ServeOptions,
    ) => Effect.Effect<ServeResult, ServeError>;
    readonly stop: (name: string) => Effect.Effect<void>;
  }
>()("Sidecar") {}

export const SidecarLive = RpcClient.layer(Sidecar, {
  main: import.meta.resolve("./SidecarServer.ts", import.meta.url),
  schema: SidecarSchema,
});
