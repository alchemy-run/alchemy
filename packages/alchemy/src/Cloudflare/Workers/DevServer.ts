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
import type { WorkerBinding } from "./Worker.ts";
import { type WorkerBundleOptions } from "./WorkerBundle.ts";

export interface ServeOptions extends WorkerBundleOptions {
  name: string;
  accountId: string;
  bindings: WorkerBinding[];
  durableObjectNamespaces: DurableObjectNamespaceInput[];
}

export const DevServerSchema = defineSchema<DevServer>({
  serve: { success: ServeResult, error: ServeError },
  stop: { success: Schema.Void, error: BridgeError },
});

export type DevServer = {
  readonly serve: (
    options: ServeOptions,
  ) => Effect.Effect<ServeResult, ServeError>;
  readonly stop: (name: string) => Effect.Effect<void, BridgeError>;
};

export class DevServerClient extends RpcClient.RpcClientService<
  DevServerClient,
  DevServer
>()("DevServerClient") {}

export const DevServerClientLive = RpcClient.layer(DevServerClient, {
  main: import.meta.resolve("./DevServerLive.ts", import.meta.url),
  schema: DevServerSchema,
});
