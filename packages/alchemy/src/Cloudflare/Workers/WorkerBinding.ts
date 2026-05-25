import type * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rpc } from "../../Rpc.ts";
import { isYieldableEffectLike } from "../../Util/effect.ts";
import type { AiGateway } from "../AiGateway/AiGateway.ts";
import { AnalyticsEngineDataset } from "../AnalyticsEngine/AnalyticsEngineDataset.ts";
import { Artifacts } from "../Artifacts/Artifacts.ts";
import { BrowserRendering } from "../BrowserRendering/BrowserRendering.ts";
import type { D1Database } from "../D1/D1Database.ts";
import { SendEmail } from "../Email/SendEmail.ts";
import { Hyperdrive } from "../Hyperdrive/Hyperdrive.ts";
import { Images } from "../Images/Images.ts";
import type { KVNamespace } from "../KV/KVNamespace.ts";
import type { Queue } from "../Queue/Queue.ts";
import type { R2Bucket } from "../R2/R2Bucket.ts";
import type { Assets } from "./Assets.ts";
import type { DurableObjectNamespaceLike } from "./DurableObjectNamespace.ts";
import { makeRpcStub } from "./Rpc.ts";
import { isWorker, Worker, WorkerEnvironment } from "./Worker.ts";

export type WorkerBinding = Exclude<
  workers.PutScriptRequest["metadata"]["bindings"],
  undefined
>[number];

export type WorkerSettingsBinding = Exclude<
  workers.GetScriptScriptAndVersionSettingResponse["bindings"],
  null | undefined
>[number];

export type WorkerBindingResource =
  | Assets
  | R2Bucket
  | D1Database
  | KVNamespace
  | Queue
  | AiGateway
  | AnalyticsEngineDataset
  | SendEmail
  | Artifacts
  | BrowserRendering
  | Images
  | Hyperdrive
  | Worker
  | DurableObjectNamespaceLike<any>;

export type WorkerBindings = {
  [bindingName in string]: WorkerBindingResource;
};

export const bindWorker = Effect.fnUntraced(function* <Shape, Req = never>(
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

export class BindWorkerPolicy extends Binding.Policy<
  BindWorkerPolicy,
  (worker: Worker) => Effect.Effect<void>
>()("Cloudflare.Worker.Bind") {}

export const BindWorkerPolicyLive = BindWorkerPolicy.layer.succeed(
  Effect.fn(function* (host, worker: Worker) {
    if (isWorker(host)) {
      yield* host.bind`${worker}`({
        bindings: [
          {
            type: "service",
            name: worker.LogicalId,
            service: worker.workerName,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`BindWorkerPolicy does not support runtime '${host.Type}'`),
      );
    }
  }),
);
