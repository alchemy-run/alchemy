import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Node from "@distilled.cloud/celld/node";
import { Endpoint } from "@distilled.cloud/celld/Endpoint";
import { Artifacts, makeScopedArtifacts } from "@/Artifacts.ts";
import {
  publishApplication,
  readPublicationReceipt,
} from "@/Celld/Deployment.ts";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { makeS3Store } from "@/Celld/FleetStorageS3.ts";
import { Namespace, NamespaceProvider } from "@/Celld/KV/Namespace.ts";
import { Bucket, BucketProvider } from "@/Celld/R2/Bucket.ts";
import { readStagedDeployment } from "@/Celld/StagedDeployment.ts";
import { CelldWorkerProvider, Worker } from "@/Celld/Worker.ts";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  fixtureBucket,
  fixtureCredentials,
} from "./fixtures/prepare-d1-live.ts";

const nodeUrl = process.env.CELLD_INTEGRATION_NODE_URL;
const workerUrl = process.env.CELLD_INTEGRATION_WORKER_URL;
const storageUrl = process.env.CELLD_D1_STORAGE_URL;
const enabled = !!nodeUrl && !!workerUrl && !!storageUrl;
const instanceId = "0123456789abcdef0123456789abcdef";
const owner = {
  stack: "CelldIntegration",
  stage: "test",
  fqn: "Application",
  instanceId,
};

// This exercises staging and explicit publication, not ApplicationActivation readiness.
test.skipIf(!enabled)(
  "API-only publication loads the default bundled Effect Worker",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const url of [nodeUrl, workerUrl, storageUrl]) {
          if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url ?? ""))
            return yield* Effect.fail(
              new Error("Use only the owned loopback integration fixture."),
            );
        }
        const module = yield* Effect.promise(
          () => import("./fixtures/integration/worker.ts"),
        );
        expect(typeof module.default).toBe("function");
        const connection = {
          fleetId: "IntegrationFleet",
          fleetUrl: workerUrl!,
          bucket: {
            uri: `s3://${fixtureBucket}`,
            endpoint: storageUrl!,
            region: "us-east-1",
          },
          hostState: undefined,
        };
        const http = yield* HttpClient.HttpClient;
        const store = yield* makeS3Store(
          connection.bucket,
          fixtureCredentials,
          http,
        );
        const artifacts = yield* Effect.sync(() =>
          makeScopedArtifacts(new Map(), "IntegrationWorker"),
        );
        const context = Layer.mergeAll(
          NodeServices.layer,
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
          Layer.succeed(InstanceId, instanceId),
        );
        const providers = Layer.mergeAll(
          CelldWorkerProvider(),
          NamespaceProvider(),
          BucketProvider(),
        ).pipe(Layer.provideMerge(context));
        const staged = yield* Effect.gen(function* () {
          const session = {
            ...noopSession,
            note: (message: string) => Effect.log(message),
          };
          const input = {
            instanceId,
            session,
            bindings: [],
            olds: undefined,
            output: undefined,
          };
          const kv = yield* (yield* Namespace.Provider).reconcile({
            ...input,
            id: "KV",
            fqn: "KV",
            news: { ...connection, title: "Integration KV" },
          });
          const r2 = yield* (yield* Bucket.Provider).reconcile({
            ...input,
            id: "FILES",
            fqn: "FILES",
            news: { ...connection, bucketName: "alchemy-integration-r2" },
          });
          const provider = yield* Worker.Provider;
          return yield* provider.reconcile({
            ...input,
            id: "IntegrationWorker",
            fqn: "IntegrationWorker",
            news: {
              ...connection,
              main: new URL("./fixtures/integration/worker.ts", import.meta.url)
                .href,
              celldVersion: "0.5.0",
              fleetSecret: Redacted.make("local-integration-gateway-secret"),
              compatibilityDate: "2026-09-01",
              compatibilityFlags: ["nodejs_compat"],
              bindings: [
                {
                  type: "kv_namespace",
                  name: "KV",
                  namespaceId: kv.namespaceId,
                },
                { type: "r2_bucket", name: "FILES", bucketName: r2.bucketName },
                {
                  type: "d1",
                  name: "D1_OPERATOR",
                  id: "alchemy-integration-d1",
                },
                {
                  type: "queue",
                  name: "QUEUE_OPERATOR",
                  queueName: "alchemy-integration-queue",
                },
              ],
            },
          });
        }).pipe(Effect.provide(providers));
        const prepared = yield* readStagedDeployment(
          store,
          staged.stagedManifestKey,
        );
        const previous = yield* readPublicationReceipt(store);
        const publication = yield* publishApplication(store, {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: `integration-${prepared.version}-${previous?.revision.slice(0, 16) ?? "initial"}`,
          priorRevision: previous?.revision,
        });
        expect((yield* Node.reloadDeployment({})).ok).toBe(true);
        const observed = yield* Node.getNodeState({}).pipe(
          Effect.repeat({
            until: (state) =>
              state.deployment?.version === prepared.version &&
              state.deployment?.prefix === prepared.prefix,
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
        );
        expect(observed.deployment?.version).toBe(prepared.version);
        expect(observed.deployment?.prefix).toBe(prepared.prefix);
        const response = yield* http.get(`${workerUrl}/`);
        const body = yield* response.text;
        yield* Effect.log({
          workerName: staged.workerName,
          version: prepared.version,
          prefix: prepared.prefix,
          revision: publication.revision,
          status: response.status,
          body,
          kvUrl: `${workerUrl}/kv`,
          r2Url: `${workerUrl}/r2`,
          owner,
        });
        expect(response.status).toBe(200);
        expect(body).toBe(
          '{"runtime":"celld","integration":"bundled-effect-worker"}',
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            FetchHttpClient.layer,
            Layer.succeed(Endpoint, nodeUrl ?? "http://127.0.0.1:1"),
          ),
        ),
        Effect.timeout("110 seconds"),
      ),
    ),
  { timeout: 120_000 },
);
