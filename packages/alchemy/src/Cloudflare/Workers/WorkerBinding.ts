import type * as workers from "@distilled.cloud/cloudflare/workers";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Json } from "effect/Schema";
import type { Rpc } from "../../Rpc.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import type { Gateway as AiGateway } from "../AI/Gateway.ts";
import type { SearchInstance } from "../AI/SearchInstance.ts";
import type { SearchNamespace } from "../AI/SearchNamespace.ts";
import { Dataset } from "../AnalyticsEngine/Dataset.ts";
import type { Namespace as ArtifactsNamespace } from "../Artifacts/Namespace.ts";
import type { Database as D1Database } from "../D1/Database.ts";
import { SendEmail } from "../Email/SendEmail.ts";
import type { App as FlagshipApp } from "../Flagship/App.ts";
import type { Connection as Hyperdrive } from "../Hyperdrive/Connection.ts";
import type { ImagesBinding } from "../Images/ImagesBinding.ts";
import type { Namespace } from "../KV/Namespace.ts";
import type { Queue } from "../Queues/Queue.ts";
import type { Bucket } from "../R2/Bucket.ts";
import type { Secret } from "../SecretsStore/Secret.ts";
import type { Index as VectorizeIndex } from "../Vectorize/VectorizeIndex.ts";
import type { DispatchNamespace } from "../WorkersForPlatforms/DispatchNamespace.ts";
import type { WorkflowLike } from "../Workflows/Workflow.ts";
import type { Assets } from "./Assets.ts";
import type { BrowserBinding } from "./BrowserBinding.ts";
import type { DurableObjectLike } from "./DurableObject.ts";
import type { RateLimitBinding } from "./RateLimitBinding.ts";
import { makeRpcStub } from "./Rpc.ts";
import type { VersionMetadataBinding } from "./VersionMetadataBinding.ts";
import { Worker, WorkerEnvironment } from "./Worker.ts";
import type { WorkerLoader } from "./WorkerLoader.ts";

export type WorkerBinding = Exclude<
  workers.PutScriptRequest["metadata"]["bindings"],
  undefined
>[number];

export type WorkerSettingsBinding = Exclude<
  workers.GetScriptScriptAndVersionSettingResponse["bindings"],
  null | undefined
>[number];

export type WorkerBindingResource =
  // Config values
  | Json
  | Redacted.Redacted<Json>
  | Config.Config<Json>
  // CF resources
  | Assets
  | Bucket
  | D1Database
  | Namespace
  | Queue
  | AiGateway
  | SearchInstance
  | SearchNamespace
  | Dataset
  | SendEmail
  | ArtifactsNamespace
  | RateLimitBinding
  | BrowserBinding
  | FlagshipApp
  | ImagesBinding
  | Hyperdrive
  | VectorizeIndex
  | Secret
  | Worker
  | WorkerLoader
  | VersionMetadataBinding
  | DispatchNamespace
  | DurableObjectLike<any>
  | WorkflowLike<any>;

export type WorkerBindings = {
  [bindingName in string]: WorkerBindingResource;
};

export const bindWorker = Effect.fn(function* <Shape, Req = never>(
  workerEff:
    | (Worker & Rpc<Shape>)
    | Effect.Effect<Worker & Rpc<Shape>, never, Req>,
) {
  // Worker classes and regular Effects are both yieldable here.
  const worker = isYieldableEffectLike(workerEff)
    ? yield* workerEff as Effect.Effect<Worker & Rpc<Shape>, never, Req>
    : workerEff;
  const self = yield* Worker;
  yield* self.bind`${worker}`({
    bindings: [
      {
        type: "service",
        name: worker.LogicalId,
        service: worker.workerName,
      },
    ],
  });

  // `bindWorker` runs at *init* phase (both at plantime and at runtime
  // cold-start). `WorkerEnvironment` only exists at exec phase on the
  // deployed worker, so we hand `makeRpcStub` an `Effect<stub>` that
  // resolves the binding lazily on each method call.
  const stubEff = WorkerEnvironment.pipe(
    Effect.map((env) => (env as Record<string, unknown>)[worker.LogicalId]),
  );
  return makeRpcStub<Shape>(stubEff);
});
