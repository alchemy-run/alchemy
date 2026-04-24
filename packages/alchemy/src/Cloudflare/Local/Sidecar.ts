import { BridgeError } from "@distilled.cloud/cloudflare-runtime/bridge";
import {
  ServeError,
  ServeResult,
  type DurableObjectNamespaceInput,
} from "@distilled.cloud/cloudflare-runtime/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as RpcClient from "../../Sidecar/RpcClient.ts";
import { defineSchema } from "../../Sidecar/RpcHandler.ts";
import type { WorkerBinding } from "../Workers/Worker.ts";
import type { WorkerBundleOptions } from "../Workers/WorkerBundle.ts";

export interface ServeOptions extends WorkerBundleOptions {
  name: string;
  accountId: string;
  bindings: WorkerBinding[];
  durableObjectNamespaces: DurableObjectNamespaceInput[];
}

export const SidecarSchema = defineSchema<Sidecar["Service"]>({
  serve: { success: ServeResult, error: ServeError },
  stop: { success: Schema.Void, error: BridgeError },
});

export class Sidecar extends RpcClient.RpcClientService<
  Sidecar,
  {
    readonly serve: (
      options: ServeOptions,
    ) => Effect.Effect<ServeResult, ServeError>;
    readonly stop: (name: string) => Effect.Effect<void, BridgeError>;
  }
>()("Sidecar") {}

export const SidecarLive = RpcClient.layer(Sidecar, {
  main: import.meta.resolve("./SidecarServer.ts", import.meta.url),
  schema: SidecarSchema,
});
