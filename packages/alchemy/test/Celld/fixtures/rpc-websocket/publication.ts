import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Node from "@distilled.cloud/celld/node";
import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import { Artifacts, makeScopedArtifacts } from "@/Artifacts.ts";
import {
  ApplicationActivation,
  reconcileApplication,
} from "@/Celld/Application.ts";
import {
  durableObjectBinding,
  durableObjectStub,
} from "@/Celld/DurableObject.ts";
import { DeploymentError } from "@/Celld/Deployment/Objects.ts";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { makeS3Store } from "@/Celld/FleetStorageS3.ts";
import {
  CelldWorkerProvider,
  Worker,
  type CelldWorkerBindingContract,
} from "@/Celld/Worker.ts";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import { Self } from "@/Self.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import type {
  DurableObjectExport,
  DurableObjectHostLike,
} from "@/Workers/DurableObject.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Room, RoomLive } from "./object.ts";

// Shared isolated Application ownership is transferred by the coordinator between native suites.
const owner = {
  stack: "CelldNativeFeatures",
  stage: "test",
  fqn: "Application",
  instanceId: "abcdef0123456789abcdef0123456789",
};
const bucketName = "alchemy-celld-v05-native-features-live";

/** Capture the actual facade declaration in plan mode; never construct its RPC server here. */
export const captureRpcFixture = Effect.gen(function* () {
  const exports: Record<string, DurableObjectExport> = {};
  const bindings: CelldWorkerBindingContract[] = [];
  const host: DurableObjectHostLike = {
    Type: "Celld.Worker",
    LogicalId: "RpcSocketWorker",
    bind: () => (binding) =>
      Effect.sync(() => {
        bindings.push(binding as CelldWorkerBindingContract);
      }),
    export: (name, value) =>
      Effect.sync(() => {
        exports[name] = value;
      }),
    durableObjectBinding,
    durableObjectStub,
  };
  const context: Context.Context<any> = Context.make(Self, host).pipe(
    Context.add(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "plan" }),
    ),
  );
  yield* Room.pipe(
    Effect.provide(
      RoomLive.pipe(Layer.provideMerge(Layer.succeedContext(context))),
    ),
  );
  return { exports, bindings };
});

export interface NativeRpcEndpoints {
  readonly workerUrl: string;
  readonly nodeUrl: string;
  readonly storageUrl: string;
}

/** Stage with Worker, then publish and verify adoption under the Application publisher lock. */
export const publishRpcFixture = (endpoints: NativeRpcEndpoints) =>
  Effect.gen(function* () {
    for (const url of [
      endpoints.workerUrl,
      endpoints.nodeUrl,
      endpoints.storageUrl,
    ]) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
        return yield* Effect.fail(
          new DeploymentError({
            reason: "configuration",
            message:
              "RPC publication requires the coordinator-owned isolated loopback fleet.",
          }),
        );
      }
    }
    const http = yield* HttpClient.HttpClient;
    const bucket = {
      uri: `s3://${bucketName}`,
      endpoint: endpoints.storageUrl,
      region: "us-east-1",
    };
    const store = yield* makeS3Store(
      bucket,
      {
        AWS_ACCESS_KEY_ID: "alchemy-test",
        AWS_SECRET_ACCESS_KEY: "alchemy-test-secret",
        AWS_REGION: "us-east-1",
      },
      http,
    );
    const declaration = yield* captureRpcFixture;
    const main = yield* Effect.sync(
      () => new URL("./worker.ts", import.meta.url).href,
    );
    const artifacts = yield* Effect.sync(() =>
      makeScopedArtifacts(new Map(), "RpcSocketWorker"),
    );
    const connection = {
      fleetId: "NativeFeaturesFleet",
      fleetUrl: endpoints.workerUrl,
      bucket,
      hostState: undefined,
    };
    const activation = Layer.succeed(ApplicationActivation, {
      activate: (_connection, root) =>
        Effect.gen(function* () {
          const reloaded = yield* Node.reloadDeployment({});
          if (!reloaded.ok)
            return yield* Effect.fail(
              new DeploymentError({
                reason: "drift",
                message: "Celld rejected RPC Application reload.",
              }),
            );
          const active = yield* Node.getNodeState({}).pipe(
            Effect.repeat({
              until: (state) =>
                state.deployment?.version === root.version &&
                state.deployment.prefix === root.prefix,
              schedule: Schedule.spaced("500 millis"),
              times: 8,
            }),
          );
          if (
            active.deployment?.version !== root.version ||
            active.deployment.prefix !== root.prefix
          ) {
            return yield* Effect.fail(
              new DeploymentError({
                reason: "drift",
                message:
                  "Celld did not adopt the exact RPC Application publication.",
              }),
            );
          }
        }).pipe(
          Effect.mapError(
            (cause) =>
              new DeploymentError({
                reason: "drift",
                message: "RPC Application activation verification failed.",
                cause,
              }),
          ),
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Endpoint, endpoints.nodeUrl),
              Layer.succeed(HttpClient.HttpClient, http),
            ),
          ),
        ),
    });
    const context = Layer.mergeAll(
      Layer.succeed(FleetStorage, () => Effect.succeed(store)),
      Layer.succeed(Artifacts, artifacts),
      Layer.succeed(Stack, {
        name: owner.stack,
        stage: owner.stage,
        resources: {},
        bindings: {},
        actions: {},
      }),
      Layer.succeed(Stage, owner.stage),
      Layer.succeed(InstanceId, owner.instanceId),
      activation,
    );
    return yield* Effect.gen(function* () {
      const worker = yield* (yield* Worker.Provider).reconcile({
        id: "RpcSocketWorker",
        fqn: "RpcSocketWorker",
        instanceId: owner.instanceId,
        session: { ...noopSession, note: (message) => Effect.log(message) },
        bindings: declaration.bindings.map((data, index) => ({
          sid: `rpc-${index}`,
          data,
        })),
        olds: undefined,
        output: undefined,
        news: {
          ...connection,
          main,
          celldVersion: "0.5.0",
          fleetSecret: Redacted.make("native-rpc-gateway-secret"),
          compatibilityDate: "2026-09-01",
          compatibilityFlags: ["nodejs_compat"],
          exports: declaration.exports,
        },
      });
      return yield* reconcileApplication(
        { ...connection, entrypoint: worker, workers: [] },
        owner,
        Effect.log,
      );
    }).pipe(
      Effect.provide(CelldWorkerProvider().pipe(Layer.provideMerge(context))),
    );
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
