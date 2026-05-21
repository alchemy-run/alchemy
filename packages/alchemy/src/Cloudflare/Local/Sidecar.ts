import { RuntimeError } from "@distilled.cloud/cloudflare-runtime/RuntimeError";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BundleError } from "../../Bundle/Bundle.ts";
import type { ResourceBinding } from "../../Resource.ts";
import * as RpcClient from "../../Sidecar/RpcClient.ts";
import { defineSchema } from "../../Sidecar/RpcHandler.ts";
import type { Worker, WorkerProps } from "../Workers/Worker.ts";

export interface ReconcileOptions {
  id: string;
  props: WorkerProps;
  bindings: ResourceBinding<Worker["Binding"]>[];
  stack: { name: string; stage: string };
  instanceId: string;
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "ValidationError",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    value: Schema.Unknown,
  },
) {}

export const ServeResult = Schema.Struct({
  workerId: Schema.String,
  workerName: Schema.String,
  logpush: Schema.UndefinedOr(Schema.Boolean),
  url: Schema.String,
  tags: Schema.Array(Schema.String).pipe(Schema.mutable),
  durableObjectNamespaces: Schema.Record(Schema.String, Schema.String),
  domains: Schema.Array(
    Schema.Struct({
      hostname: Schema.String,
      id: Schema.String,
      zoneId: Schema.String,
    }),
  ).pipe(Schema.mutable),
  crons: Schema.Array(Schema.String).pipe(Schema.mutable),
  accountId: Schema.String,
});
export type ServeResult = typeof ServeResult.Type;

export const ServeError = Schema.Union([
  RuntimeError,
  BundleError,
  ValidationError,
]);
export type ServeError = typeof ServeError.Type;

export const DiffResult = Schema.Struct({
  action: Schema.Literals(["update", "noop"]),
});
export type DiffResult = typeof DiffResult.Type;

export const SidecarSchema = defineSchema<Sidecar["Service"]>({
  diff: { success: DiffResult, error: Schema.Never },
  reconcile: {
    success: ServeResult,
    error: ServeError,
  },
  delete: { success: Schema.Void, error: Schema.Never },
});

export class Sidecar extends RpcClient.RpcClientService<
  Sidecar,
  {
    readonly diff: (options: ReconcileOptions) => Effect.Effect<DiffResult>;
    readonly reconcile: (
      options: ReconcileOptions,
    ) => Effect.Effect<ServeResult, ServeError>;
    readonly delete: (id: string) => Effect.Effect<void>;
  }
>()("Sidecar") {}

export const SidecarLive = RpcClient.layer(Sidecar, {
  main: import.meta.resolve("./SidecarServer.ts", import.meta.url),
  schema: SidecarSchema,
});
