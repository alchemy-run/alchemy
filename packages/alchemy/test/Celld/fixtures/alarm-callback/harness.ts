import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import * as Node from "@distilled.cloud/celld/node";
import { Artifacts, makeScopedArtifacts } from "@/Artifacts.ts";
import {
  Application,
  ApplicationActivation,
  ApplicationProvider,
  type ApplicationAttributes,
  type ApplicationResourceProps,
} from "@/Celld/Application.ts";
import {
  APPLICATION_LOCK_KEY,
  readPublicationReceipt,
} from "@/Celld/Deployment.ts";
import { DeploymentError } from "@/Celld/Deployment/Objects.ts";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { makeS3Store } from "@/Celld/FleetStorageS3.ts";
import {
  CelldWorkerProvider,
  Worker,
  type CelldWorkerAttributes,
  type CelldWorkerResourceProps,
} from "@/Celld/Worker.ts";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

export const callbackEnvironment = {
  enabled: process.env.CELLD_CALLBACK_LIVE === "1",
  nodeUrl:
    process.env.CELLD_CALLBACK_NODE_URL ?? process.env.CELLD_NATIVE_NODE_URL,
  workerUrl:
    process.env.CELLD_CALLBACK_WORKER_URL ??
    process.env.CELLD_NATIVE_WORKER_URL,
  storageUrl:
    process.env.CELLD_CALLBACK_STORAGE_URL ??
    process.env.CELLD_NATIVE_STORAGE_URL,
  bucketName:
    process.env.CELLD_CALLBACK_BUCKET ??
    "alchemy-celld-v05-native-features-live",
  owner: {
    stack: process.env.CELLD_CALLBACK_OWNER_STACK ?? "CelldNativeFeatures",
    stage: process.env.CELLD_CALLBACK_OWNER_STAGE ?? "test",
    fqn: process.env.CELLD_CALLBACK_OWNER_FQN ?? "Application",
    instanceId:
      process.env.CELLD_CALLBACK_OWNER_INSTANCE_ID ??
      "abcdef0123456789abcdef0123456789",
  },
};

export const validateCallbackEnvironment = () =>
  Effect.gen(function* () {
    for (const [key, url] of Object.entries({
      nodeUrl: callbackEnvironment.nodeUrl,
      workerUrl: callbackEnvironment.workerUrl,
      storageUrl: callbackEnvironment.storageUrl,
    })) {
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? "")) {
        return yield* Effect.fail(
          new Error(
            `Set ${key} to the coordinator-owned loopback callback fixture.`,
          ),
        );
      }
    }
  });

/** Stages Workers and publishes only through the Application resource lifecycle. */
export const makeCallbackHarness = Effect.gen(function* () {
  if (!callbackEnvironment.enabled)
    return yield* Effect.fail(
      new Error(
        "Set CELLD_CALLBACK_LIVE=1 only after the coordinator grants exclusive publication.",
      ),
    );
  yield* validateCallbackEnvironment();
  const { owner, bucketName, workerUrl, storageUrl } = callbackEnvironment;
  const http = yield* HttpClient.HttpClient;
  const bucket = {
    uri: `s3://${bucketName}`,
    endpoint: storageUrl!,
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
  const previous = yield* readPublicationReceipt(store);
  if (
    previous &&
    (previous.owner.stack !== owner.stack ||
      previous.owner.stage !== owner.stage ||
      previous.owner.fqn !== owner.fqn ||
      previous.owner.instanceId !== owner.instanceId)
  ) {
    return yield* Effect.fail(
      new DeploymentError({
        reason: "ownership",
        message:
          "Set CELLD_CALLBACK_OWNER_* to the explicitly handed-off fixture Application owner; no foreign publication is adopted.",
      }),
    );
  }
  const connection = {
    fleetId: "CallbackFleet",
    fleetUrl: workerUrl!,
    bucket,
    hostState: undefined,
  };
  const context = Layer.mergeAll(
    Layer.succeed(FleetStorage, () => Effect.succeed(store)),
    Layer.succeed(Stack, {
      name: owner.stack,
      stage: owner.stage,
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, owner.stage),
    Layer.succeed(InstanceId, owner.instanceId),
    Layer.succeed(ApplicationActivation, {
      activate: (_connection, root) =>
        Effect.gen(function* () {
          if (!(yield* store.get(APPLICATION_LOCK_KEY))) {
            return yield* Effect.fail(
              new DeploymentError({
                reason: "locked",
                message:
                  "Native activation must run under the Application publisher lock.",
              }),
            );
          }
          const reloaded = yield* Node.reloadDeployment({});
          if (!reloaded.ok)
            return yield* Effect.fail(
              new DeploymentError({
                reason: "drift",
                message: "Native callback fixture reload was not acknowledged.",
              }),
            );
          const observed = yield* Node.getNodeState({}).pipe(
            Effect.repeat({
              until: (state) =>
                state.deployment?.version === root.version &&
                state.deployment?.prefix === root.prefix &&
                state.deployment?.swapping === 0,
              schedule: Schedule.spaced("500 millis"),
              times: 8,
            }),
          );
          if (
            observed.deployment?.version !== root.version ||
            observed.deployment?.prefix !== root.prefix ||
            observed.deployment?.swapping !== 0
          ) {
            return yield* Effect.fail(
              new DeploymentError({
                reason: "drift",
                message:
                  "Native node did not adopt the callback Application generation.",
              }),
            );
          }
        }).pipe(
          Effect.provideService(Endpoint, callbackEnvironment.nodeUrl!),
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.mapError(
            (cause) =>
              new DeploymentError({
                reason: "configuration",
                message: "Callback Application activation failed.",
                cause,
              }),
          ),
        ),
    }),
  );
  const providers = Layer.mergeAll(
    CelldWorkerProvider(),
    ApplicationProvider(),
  ).pipe(Layer.provideMerge(context));
  let workerOutput: CelldWorkerAttributes | undefined;
  let workerProps: CelldWorkerResourceProps | undefined;
  let applicationOutput: ApplicationAttributes | undefined;
  let applicationProps: ApplicationResourceProps | undefined;
  const publish = Effect.fn(
    function* (version: "v1" | "v2") {
      if (!callbackEnvironment.enabled)
        return yield* Effect.fail(
          new Error(
            "Set CELLD_CALLBACK_LIVE=1 only after the coordinator grants exclusive publication.",
          ),
        );
      const main = yield* Effect.sync(
        () =>
          new URL(version === "v1" ? "./v1.ts" : "./worker.ts", import.meta.url)
            .href,
      );
      const news: CelldWorkerResourceProps = {
        ...connection,
        main,
        isExternal: version === "v1",
        celldVersion: "0.5.0",
        compatibilityDate: "2026-09-01",
        compatibilityFlags: ["nodejs_compat"],
        fleetSecret: Redacted.make("callback-fixture-secret"),
        exports:
          version === "v1"
            ? {}
            : {
                AlarmObject: {
                  kind: "durableObject",
                  provider: "Celld.Worker",
                  services: Context.empty(),
                  constructor: Effect.die(
                    "Staging consumes declaration metadata only",
                  ),
                } satisfies DurableObjectExport,
              },
      };
      const worker = yield* (yield* Worker.Provider).reconcile({
        id: "AlarmWorker",
        fqn: "AlarmWorker",
        instanceId: owner.instanceId,
        session: { ...noopSession, note: (message) => Effect.log(message) },
        bindings: [
          {
            sid: "callback-objects",
            data: {
              durableObjects: [
                { name: "AlarmObject", className: "AlarmObject" },
              ],
            },
          },
        ],
        olds: workerProps,
        output: workerOutput,
        news,
      });
      workerProps = news;
      workerOutput = worker;
      const props: ApplicationResourceProps = {
        ...connection,
        entrypoint: {
          workerName: worker.workerName,
          fleetId: worker.fleetId,
          stagedManifestKey: worker.stagedManifestKey,
          exposed: worker.exposed,
          url: worker.url,
        },
        workers: [],
      };
      const application = yield* (yield* Application.Provider).reconcile({
        id: "Application",
        fqn: owner.fqn,
        instanceId: owner.instanceId,
        session: { ...noopSession, note: (message) => Effect.log(message) },
        bindings: [],
        olds: applicationProps,
        output: applicationOutput,
        news: props,
      });
      applicationProps = props;
      applicationOutput = application;
      yield* Effect.logInfo("Callback Application activated", {
        version,
        workerName: worker.workerName,
        revision: application.revision,
      });
      return { worker, application };
    },
    Effect.provide(providers),
    Effect.provideServiceEffect(
      Artifacts,
      Effect.sync(() => makeScopedArtifacts(new Map(), "AlarmWorker")),
    ),
  );
  return { publish };
});
