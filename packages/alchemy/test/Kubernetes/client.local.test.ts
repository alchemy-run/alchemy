import { Drifted } from "@/AdoptPolicy";
import * as Kubernetes from "@/Kubernetes";
import type { Connection } from "@/Kubernetes/Connection.ts";
import {
  applyObject,
  connectCluster,
  deleteObject,
  KubernetesApiError,
} from "@/Kubernetes/internal/client.ts";
import * as Provider from "@/Provider";
import { noopSession } from "@/Report";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";

const { test } = Test.make({
  providers: Layer.mergeAll(Kubernetes.providers(), NodeServices.layer),
});
const chartDir = `${import.meta.dirname}/fixtures/chart`;

// Checked-in localhost cert so the fake API server doesn't shell out.
// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
//   -days 3650 -subj "/CN=127.0.0.1"
const CERT = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUeb9c+F96RuibqO7hmAOgxAo5UfowCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTAwMzA5NDc0OFoXDTM2MDkzMDA5
NDc0OFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEmc+ugTTXDf4BLU5ofl62yr1e2vYIowVGymzbf4i2G1YBCz93mURUf6vK
C57tMdEjrz9baaqZUmjc9bsR/4JPdKNTMFEwHQYDVR0OBBYEFFpEOLU4MsTEf7VB
eGpaa7Ylk8xqMB8GA1UdIwQYMBaAFFpEOLU4MsTEf7VBeGpaa7Ylk8xqMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhANxAymiHqjn9B2u9+G/bU5D9
QcwCvSUdiiKoyUld9RKpAiB8W37pNKCgPyyleJtLx5ZTQCQF118B+d/aE/y3pS/e
Rg==
-----END CERTIFICATE-----
`;

const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgCiHHWdXKsVQBYX/G
48QLItkHv8POVFiWaDmRxU5SMNehRANCAASZz66BNNcN/gEtTmh+XrbKvV7a9gij
BUbKbNt/iLYbVgELP3eZRFR/q8oLnu0x0SOvP1tpqplSaNz1uxH/gk90
-----END PRIVATE KEY-----
`;

const session = { ...noopSession, note: () => Effect.void };

const connectionFor = (endpoint: string): Connection => ({
  endpoint,
  insecureSkipTlsVerify: true,
  auth: { kind: "token", token: "test-token" },
});

const configMap = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "token", namespace: "default" },
};

const serve = <A, E, R>(
  onRequest: (request: IncomingMessage, response: ServerResponse) => void,
  use: (endpoint: string) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.callback<https.Server, Error>((resume) => {
          let settled = false;
          const finish = (effect: Effect.Effect<https.Server, Error>) => {
            if (settled) return;
            settled = true;
            resume(effect);
          };
          const created = https.createServer(
            { key: KEY, cert: CERT },
            onRequest,
          );
          created.once("error", (error) => finish(Effect.fail(error)));
          created.listen(0, "127.0.0.1", () => finish(Effect.succeed(created)));
        }),
        (created) =>
          Effect.sync(() => {
            created.closeAllConnections();
            created.close();
          }),
      );
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      return yield* use(`https://127.0.0.1:${port}`);
    }),
  );

test.provider(
  "apply sends unwrapped Redacted values and scrubs them from error bodies",
  () =>
    serve(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (request.url?.includes("fail")) {
            const secret = "s3cr3t";
            response.writeHead(400);
            response.end(
              JSON.stringify({
                message: secret,
                data: Buffer.from(secret).toString("base64"),
              }),
            );
            return;
          }
          response.writeHead(200);
          response.end(
            JSON.stringify({ metadata: { uid: "uid-1" }, echo: body }),
          );
        });
      },
      (endpoint) =>
        Effect.gen(function* () {
          const transport = yield* connectCluster(connectionFor(endpoint));
          const applied = yield* applyObject({
            transport,
            object: {
              ...configMap,
              metadata: { name: "token", namespace: "default" },
              stringData: Redacted.make({ token: Redacted.make("s3cr3t") }),
            },
          });
          const echo = (applied as { echo?: string }).echo ?? "";
          expect(echo).toContain("s3cr3t");
          expect(echo).not.toContain("<redacted>");

          const failed = yield* Effect.result(
            applyObject({
              transport,
              object: {
                ...configMap,
                metadata: { name: "fail", namespace: "default" },
                stringData: { token: Redacted.make("s3cr3t") },
              },
            }),
          );
          expect(Result.isFailure(failed)).toBe(true);
          if (Result.isFailure(failed)) {
            expect(failed.failure).toBeInstanceOf(KubernetesApiError);
            const error = failed.failure as KubernetesApiError;
            expect(error.body).not.toContain("s3cr3t");
            expect(error.body).not.toContain(
              Buffer.from("s3cr3t").toString("base64"),
            );
            expect(error.message).not.toContain("s3cr3t");
          }

          const plain = yield* Effect.result(
            applyObject({
              transport,
              secrets: ["s3cr3t"],
              object: {
                ...configMap,
                metadata: { name: "fail-plain", namespace: "default" },
                stringData: { token: "s3cr3t" },
              },
            }),
          );
          expect(Result.isFailure(plain)).toBe(true);
          if (Result.isFailure(plain)) {
            expect(plain.failure).toBeInstanceOf(KubernetesApiError);
            const error = plain.failure as KubernetesApiError;
            expect(error.body).not.toContain("s3cr3t");
            expect(error.body).not.toContain(
              Buffer.from("s3cr3t").toString("base64"),
            );
            expect(error.message).not.toContain("s3cr3t");
          }
        }),
    ),
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "interrupting a stalled request unblocks the fiber",
  () => {
    let arrived = false;
    return serve(
      (request) => {
        request.resume();
        arrived = true;
      },
      (endpoint) =>
        Effect.gen(function* () {
          const transport = yield* connectCluster(connectionFor(endpoint));
          const fiber = yield* Effect.forkChild(
            applyObject({
              transport,
              object: configMap,
            }),
          );
          const seen = yield* Effect.sync(() => arrived).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 millis"),
              until: (value) => value,
              times: 50,
            }),
          );
          expect(seen).toBe(true);
          const started = yield* Effect.sync(() => Date.now());
          yield* Fiber.interrupt(fiber);
          const elapsed = yield* Effect.sync(() => Date.now() - started);
          // A stalled response used to pin the fiber until the process gave
          // up. Interruption must win before the 10s attempt deadline.
          expect(elapsed).toBeLessThan(2_000);
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "delete tolerates 404 and surfaces 403",
  () =>
    serve(
      (request, response) => {
        const status = request.url?.includes("missing") ? 404 : 403;
        response.writeHead(status);
        response.end("");
      },
      (endpoint) =>
        Effect.gen(function* () {
          const transport = yield* connectCluster(connectionFor(endpoint));
          const object = {
            apiVersion: "v1",
            kind: "ConfigMap",
            name: "missing",
            namespace: "default",
          };
          yield* deleteObject({ transport, object });

          const forbidden = yield* Effect.result(
            deleteObject({
              transport,
              object: { ...object, name: "kept" },
            }),
          );
          expect(Result.isFailure(forbidden)).toBe(true);
          if (Result.isFailure(forbidden)) {
            expect(forbidden.failure).toBeInstanceOf(KubernetesApiError);
            expect((forbidden.failure as KubernetesApiError).statusCode).toBe(
              403,
            );
          }

          const connection = connectionFor(endpoint);
          const ref = {
            apiVersion: "v1",
            kind: "ConfigMap",
            name: "kept",
            namespace: "default",
          };
          const manifest = yield* Provider.findProvider(Kubernetes.Manifest);
          const manifestDelete = yield* Effect.result(
            manifest.delete({
              id: "Token",
              fqn: "Token",
              instanceId: "i",
              olds: { cluster: connection, manifest: configMap },
              output: {
                connection,
                apiVersion: "v1",
                kind: "ConfigMap",
                name: "kept",
                namespace: "default",
                ref,
                uid: "uid-1",
              },
              session,
              bindings: [],
            }),
          );
          expect(Result.isFailure(manifestDelete)).toBe(true);

          const deployment = yield* Provider.findProvider(
            Kubernetes.Deployment,
          );
          const deploymentDelete = yield* Effect.result(
            deployment.delete({
              id: "App",
              fqn: "App",
              instanceId: "i",
              olds: { cluster: connection, image: "nginx:1" },
              output: {
                connection,
                namespace: "default",
                deploymentName: "app",
                serviceName: "app",
                serviceAccountName: "app",
                port: 80,
                imageUri: "nginx:1",
                identity: undefined,
                registry: undefined,
                url: undefined,
                kubernetesObjects: [ref],
                code: { hash: "abc" },
              },
              session,
              bindings: [],
            }),
          );
          expect(Result.isFailure(deploymentDelete)).toBe(true);

          const job = yield* Provider.findProvider(Kubernetes.Job);
          const jobDelete = yield* Effect.result(
            job.delete({
              id: "Work",
              fqn: "Work",
              instanceId: "i",
              olds: { cluster: connection, image: "nginx:1" },
              output: {
                connection,
                namespace: "default",
                kind: "Job",
                jobName: "work",
                schedule: undefined,
                serviceAccountName: "app",
                imageUri: "nginx:1",
                identity: undefined,
                registry: undefined,
                kubernetesObjects: [ref],
                code: { hash: "abc" },
              },
              session,
              bindings: [],
            }),
          );
          expect(Result.isFailure(jobDelete)).toBe(true);
        }),
    ),
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "drift read notices manifest field edits and missing helm objects",
  () => {
    let liveToken = "s3cr3t";
    let liveSecret = "s3cr3t";
    let liveMessage = "s3cr3t";
    return serve(
      (request, response) => {
        const url = request.url ?? "";
        if (request.method === "DELETE") {
          response.writeHead(200);
          response.end("");
          return;
        }
        if (url.includes("/configmaps/missing")) {
          response.writeHead(404);
          response.end("");
          return;
        }
        if (url.includes("/configmaps/kept")) {
          response.writeHead(200);
          response.end(JSON.stringify({ metadata: { uid: "kept" } }));
          return;
        }
        if (url.includes("/configmaps/probe-config")) {
          if (request.method === "GET") {
            response.writeHead(200);
            response.end(
              JSON.stringify({
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: {
                  name: "probe-config",
                  namespace: "default",
                  uid: "uid-1",
                  resourceVersion: "9",
                  annotations: { "deployed-at": "stored" },
                },
                data: {
                  message: liveMessage,
                  release: "probe",
                  namespace: "default",
                },
              }),
            );
            return;
          }
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          request.on("end", () => {
            const submitted = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as { metadata?: Record<string, unknown> };
            response.writeHead(200);
            response.end(
              JSON.stringify({
                ...submitted,
                metadata: {
                  ...submitted.metadata,
                  uid: "uid-1",
                  resourceVersion: "10",
                  annotations: { "deployed-at": "now" },
                },
              }),
            );
          });
          return;
        }
        if (url.includes("/secrets/")) {
          if (request.method === "GET") {
            response.writeHead(200);
            response.end(
              JSON.stringify({
                apiVersion: "v1",
                kind: "Secret",
                metadata: {
                  name: "token",
                  namespace: "default",
                  uid: "uid-1",
                  resourceVersion: "9",
                },
                type: "Opaque",
                data: {
                  token: Buffer.from(liveSecret).toString("base64"),
                },
              }),
            );
            return;
          }
          const chunks: Buffer[] = [];
          request.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          request.on("end", () => {
            const submitted = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as { stringData?: { token?: string } };
            // stringData is write-only; the stored object has base64 data.
            response.writeHead(200);
            response.end(
              JSON.stringify({
                apiVersion: "v1",
                kind: "Secret",
                metadata: {
                  name: "token",
                  namespace: "default",
                  uid: "uid-1",
                  resourceVersion: "10",
                },
                type: "Opaque",
                data: {
                  token: Buffer.from(
                    submitted.stringData?.token ?? "",
                  ).toString("base64"),
                },
              }),
            );
          });
          return;
        }
        const nested = url.includes("/configmaps/nested");
        if (request.method === "GET") {
          response.writeHead(200);
          response.end(
            JSON.stringify({
              ...configMap,
              metadata: {
                name: nested ? "nested" : "token",
                namespace: "default",
                uid: "uid-1",
                resourceVersion: "9",
                managedFields: [{ manager: "alchemy" }],
                annotations: { "deployed-at": "stored" },
              },
              ...(nested
                ? { spec: { metadata: { uid: "edited", generation: 1 } } }
                : { data: { token: liveToken } }),
              status: { phase: "Active" },
            }),
          );
          return;
        }
        response.writeHead(200);
        response.end(
          JSON.stringify({
            ...configMap,
            metadata: {
              name: nested ? "nested" : "token",
              namespace: "default",
              uid: "uid-1",
              resourceVersion: "10",
              managedFields: [{ manager: "alchemy", time: "now" }],
              annotations: { "deployed-at": "now" },
            },
            ...(nested
              ? { spec: { metadata: { uid: "declared", generation: 2 } } }
              : { data: { token: "s3cr3t" } }),
          }),
        );
      },
      (endpoint) =>
        Effect.gen(function* () {
          const connection = connectionFor(endpoint);
          const manifest = yield* Provider.findProvider(Kubernetes.Manifest);
          const output = {
            connection,
            apiVersion: "v1",
            kind: "ConfigMap",
            name: "token",
            namespace: "default",
            ref: {
              apiVersion: "v1",
              kind: "ConfigMap",
              name: "token",
              namespace: "default",
            },
            uid: "uid-1",
          };
          const olds = {
            cluster: connection,
            manifest: { ...configMap, data: { token: "s3cr3t" } },
          };
          if (manifest.read === undefined) {
            return yield* Effect.die("provider read is required");
          }
          const inSync = yield* manifest.read({
            id: "Token",
            fqn: "Token",
            instanceId: "i",
            olds,
            output,
          });
          expect(Drifted.is(inSync)).toBe(false);
          expect(inSync?.uid).toBe("uid-1");

          liveToken = "nope";
          const edited = yield* manifest.read({
            id: "Token",
            fqn: "Token",
            instanceId: "i",
            olds,
            output,
          });
          expect(Drifted.is(edited)).toBe(true);

          const nested = yield* manifest.read({
            id: "Nested",
            fqn: "Nested",
            instanceId: "i",
            olds: {
              cluster: connection,
              manifest: {
                ...configMap,
                metadata: { name: "nested", namespace: "default" },
                spec: { metadata: { uid: "declared", generation: 2 } },
              },
            },
            output: {
              ...output,
              name: "nested",
              ref: { ...output.ref, name: "nested" },
            },
          });
          expect(Drifted.is(nested)).toBe(true);

          const secretOlds = {
            cluster: connection,
            manifest: {
              apiVersion: "v1",
              kind: "Secret",
              metadata: { name: "token", namespace: "default" },
              stringData: { token: Redacted.make("s3cr3t") },
            },
          };
          const secretOutput = {
            ...output,
            kind: "Secret",
            ref: { ...output.ref, kind: "Secret" },
          };
          const secretInSync = yield* manifest.read({
            id: "Secret",
            fqn: "Secret",
            instanceId: "i",
            olds: secretOlds,
            output: secretOutput,
          });
          expect(Drifted.is(secretInSync)).toBe(false);

          liveSecret = "nope";
          const secretEdited = yield* manifest.read({
            id: "Secret",
            fqn: "Secret",
            instanceId: "i",
            olds: secretOlds,
            output: secretOutput,
          });
          expect(Drifted.is(secretEdited)).toBe(true);

          const helm = yield* Provider.findProvider(Kubernetes.HelmChart);
          if (helm.read === undefined) {
            return yield* Effect.die("provider read is required");
          }
          const probe = {
            apiVersion: "v1",
            kind: "ConfigMap",
            name: "probe-config",
            namespace: "default",
          };
          const missing = { ...probe, name: "missing" };
          const helmOutput = {
            connection,
            releaseName: "probe",
            namespace: "default",
            chart: chartDir,
            version: undefined,
            objects: [probe, missing],
            code: { hash: "abc" },
          };
          const helmOlds = {
            cluster: connection,
            chart: chartDir,
            releaseName: "probe",
            values: { message: "s3cr3t" },
          };
          const observed = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: helmOlds,
            output: helmOutput,
          });
          expect(observed?.objects).toEqual([probe]);
          expect(Drifted.is(observed)).toBe(false);

          liveMessage = "edited";
          const editedChart = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: helmOlds,
            output: helmOutput,
          });
          expect(Drifted.is(editedChart)).toBe(true);
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "turning createNamespace off releases the namespace without deleting it",
  () => {
    const hits: string[] = [];
    return serve(
      (request, response) => {
        hits.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
        request.resume();
        response.writeHead(200);
        response.end(JSON.stringify({ metadata: { uid: "u" } }));
      },
      (endpoint) =>
        Effect.gen(function* () {
          const helm = yield* Provider.findProvider(Kubernetes.HelmChart);
          const connection = connectionFor(endpoint);
          const updated = yield* helm.reconcile({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            news: {
              cluster: connection,
              chart: chartDir,
              releaseName: "probe",
              namespace: "shared",
              createNamespace: false,
            },
            olds: {
              cluster: connection,
              chart: chartDir,
              releaseName: "probe",
              namespace: "shared",
              createNamespace: true,
            },
            output: {
              connection,
              releaseName: "probe",
              namespace: "shared",
              chart: chartDir,
              version: undefined,
              objects: [
                { apiVersion: "v1", kind: "Namespace", name: "shared" },
                {
                  apiVersion: "v1",
                  kind: "ConfigMap",
                  name: "probe-config",
                  namespace: "shared",
                },
              ],
              code: { hash: "stale" },
            },
            session,
            bindings: [],
          });
          expect(updated.objects.map((object) => object.kind)).toEqual([
            "ConfigMap",
          ]);
          expect(
            hits.some(
              (hit) =>
                hit.startsWith("DELETE") && hit.includes("/namespaces/shared"),
            ),
          ).toBe(false);
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 30_000 },
);
