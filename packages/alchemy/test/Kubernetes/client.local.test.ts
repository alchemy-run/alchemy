import type { IncomingMessage, ServerResponse } from "node:http";
import * as https from "node:https";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Kubernetes from "@/Kubernetes";
import type { Connection } from "@/Kubernetes/Connection.ts";
import {
  applyObject,
  connectCluster,
  deleteObject,
  KubernetesApiError,
  readObject,
} from "@/Kubernetes/internal/client.ts";
import { driftMask, hashDriftSelection } from "@/Kubernetes/internal/declared.ts";
import type { KubernetesManifest } from "@/Kubernetes/Manifest.ts";
import * as Provider from "@/Provider";
import { noopSession } from "@/Report";
import * as Test from "@/Test/Alchemy";

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
          const created = https.createServer({ key: KEY, cert: CERT }, onRequest);
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

const onBody = (request: IncomingMessage, use: (body: string) => void) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  request.on("end", () => {
    use(Buffer.concat(chunks).toString("utf8"));
  });
};

const drifted = (value: { observedHash?: string } | undefined) =>
  typeof value?.observedHash === "string";

test.provider(
  "apply sends unwrapped Redacted values and scrubs them from error bodies",
  () =>
    serve(
      (request, response) => {
        onBody(request, (body) => {
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
          response.end(JSON.stringify({ metadata: { uid: "uid-1" }, echo: body }));
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
            const encoded = yield* Effect.sync(() => Buffer.from("s3cr3t").toString("base64"));
            expect(error.body).not.toContain(encoded);
            expect(error.message).not.toContain("s3cr3t");
          }
        }),
    ),
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "read retries HTTP 429 and then returns the object",
  () => {
    let attempts = 0;
    return serve(
      (_request, response) => {
        attempts += 1;
        if (attempts === 1) {
          response.writeHead(429);
          response.end(JSON.stringify({ message: "too many requests" }));
          return;
        }
        response.writeHead(200);
        response.end(JSON.stringify({ ...configMap, data: { token: "ok" } }));
      },
      (endpoint) =>
        Effect.gen(function* () {
          const transport = yield* connectCluster(connectionFor(endpoint));
          const observed = yield* readObject({
            transport,
            object: {
              apiVersion: "v1",
              kind: "ConfigMap",
              name: "token",
              namespace: "default",
            },
          });
          expect(attempts).toBe(2);
          expect((observed as { data?: { token?: string } }).data?.token).toBe("ok");
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "apply sends a redacted container and scrubs its strings from the error",
  () => {
    let received = "";
    const secret = "s3cr3t";
    const nested = "another-secret";
    return serve(
      (request, response) => {
        onBody(request, (body) => {
          received = body;
          response.writeHead(400);
          response.end(received);
        });
      },
      (endpoint) =>
        Effect.gen(function* () {
          const transport = yield* connectCluster(connectionFor(endpoint));
          const failed = yield* Effect.result(
            applyObject({
              transport,
              object: {
                ...configMap,
                metadata: { name: "nested", namespace: "default" },
                data: { note: "ordinary-text" },
                stringData: Redacted.make({ token: secret, nested }),
              },
            }),
          );
          expect(received).toContain(secret);
          expect(received).toContain(nested);
          expect(received).toContain("ordinary-text");
          expect(Result.isFailure(failed)).toBe(true);
          if (Result.isFailure(failed)) {
            expect(failed.failure).toBeInstanceOf(KubernetesApiError);
            const error = failed.failure as KubernetesApiError;
            expect(error.body).toContain("ordinary-text");
            expect(error.body).toContain("<redacted>");
            expect(error.body).not.toContain(secret);
            expect(error.body).not.toContain(nested);
            expect(error.message).toContain("ordinary-text");
            expect(error.message).not.toContain(secret);
            expect(error.message).not.toContain(nested);
          }
        }),
    );
  },
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
              times: 10,
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
  "a stalled header mint fails at the deadline",
  () =>
    Effect.gen(function* () {
      const started = yield* Effect.sync(() => Date.now());
      const result = yield* Effect.result(
        applyObject({
          transport: {
            endpoint: "https://127.0.0.1:1",
            insecureSkipTlsVerify: true,
            headers: Effect.never,
          },
          object: configMap,
        }),
      );
      const elapsed = yield* Effect.sync(() => Date.now() - started);
      expect(Result.isFailure(result)).toBe(true);
      expect(elapsed).toBeGreaterThan(8_000);
      expect(elapsed).toBeLessThan(15_000);
    }),
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "a stalled HTTP attempt times out at the deadline",
  () => {
    const arrivals: number[] = [];
    return serve(
      (request, response) => {
        arrivals.push(Date.now());
        request.resume();
        if (arrivals.length < 2) return;
        response.writeHead(200);
        response.end(JSON.stringify({ ...configMap, data: { token: "ok" } }));
      },
      (endpoint) =>
        Effect.gen(function* () {
          const transport = yield* connectCluster(connectionFor(endpoint));
          const observed = yield* readObject({
            transport,
            object: {
              apiVersion: "v1",
              kind: "ConfigMap",
              name: "token",
              namespace: "default",
            },
          });
          expect(arrivals.length).toBeGreaterThanOrEqual(2);
          const gap = arrivals[1]! - arrivals[0]!;
          // Each attempt dies at 10s, then the retry spacing starts the next one.
          expect(gap).toBeGreaterThan(8_000);
          expect(gap).toBeLessThan(22_000);
          expect((observed as { data?: { token?: string } }).data?.token).toBe("ok");
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 40_000 },
);

test.provider(
  "delete tolerates 404 and surfaces 403",
  () =>
    serve(
      (request, response) => {
        const status = request.url?.includes("missing")
          ? 404
          : request.url?.includes("broken")
            ? 500
            : 403;
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
            expect((forbidden.failure as KubernetesApiError).statusCode).toBe(403);
          }
          const broken = yield* Effect.result(
            deleteObject({
              transport,
              object: { ...object, name: "broken" },
            }),
          );
          expect(Result.isFailure(broken)).toBe(true);
          if (Result.isFailure(broken)) {
            expect(broken.failure).toBeInstanceOf(KubernetesApiError);
            expect((broken.failure as KubernetesApiError).statusCode).toBe(500);
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

          const deployment = yield* Provider.findProvider(Kubernetes.Deployment);
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
    const deleted: string[] = [];
    const methods: string[] = [];
    return serve(
      (request, response) => {
        const url = request.url ?? "";
        methods.push(request.method ?? "");
        if (request.method === "DELETE") {
          deleted.push(url);
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
          onBody(request, (body) => {
            const submitted = JSON.parse(body) as {
              metadata?: Record<string, unknown>;
            };
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
          onBody(request, (body) => {
            const submitted = JSON.parse(body) as {
              stringData?: { token?: string };
            };
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
                  token: Buffer.from(submitted.stringData?.token ?? "").toString("base64"),
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
          expect(drifted(inSync)).toBe(false);
          expect(inSync?.uid).toBe("uid-1");
          expect(methods.includes("PATCH")).toBe(false);

          liveToken = "nope";
          const edited = yield* manifest.read({
            id: "Token",
            fqn: "Token",
            instanceId: "i",
            olds,
            output,
          });
          expect(drifted(edited)).toBe(true);

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
          expect(drifted(nested)).toBe(true);

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
          expect(drifted(secretInSync)).toBe(false);

          liveSecret = "nope";
          const secretEdited = yield* manifest.read({
            id: "Secret",
            fqn: "Secret",
            instanceId: "i",
            olds: secretOlds,
            output: secretOutput,
          });
          expect(drifted(secretEdited)).toBe(true);

          const helm = yield* Provider.findProvider(Kubernetes.HelmChart);
          if (helm.read === undefined || helm.reconcile === undefined) {
            return yield* Effect.die("provider read is required");
          }
          const probe = {
            apiVersion: "v1",
            kind: "ConfigMap",
            name: "probe-config",
            namespace: "default",
          };
          const missing = { ...probe, name: "missing" };
          const helmOlds = {
            cluster: connection,
            chart: chartDir,
            releaseName: "probe",
            values: { message: "s3cr3t" },
          };
          const reconciled = yield* helm.reconcile({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            news: helmOlds,
            olds: undefined,
            output: undefined,
            session,
            bindings: [],
          });
          methods.length = 0;
          const presentOnly = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: helmOlds,
            output: reconciled,
          });
          expect(drifted(presentOnly)).toBe(false);
          expect(methods.includes("PATCH")).toBe(false);

          liveMessage = "edited";
          const editedChart = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: helmOlds,
            output: reconciled,
          });
          expect(drifted(editedChart)).toBe(true);
          liveMessage = "s3cr3t";

          const observed = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: helmOlds,
            output: {
              ...reconciled,
              objects: [...reconciled.objects, missing],
            },
          });
          expect(drifted(observed)).toBe(true);
          expect(observed?.objects?.map((object) => object.name)).toEqual([
            "probe-config",
            "missing",
          ]);

          yield* helm.reconcile({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            news: { ...helmOlds, namespace: "shared", createNamespace: false },
            olds: { ...helmOlds, namespace: "shared", createNamespace: true },
            output: {
              ...reconciled,
              namespace: "shared",
              objects: [
                { apiVersion: "v1", kind: "Namespace", name: "shared" },
                { ...probe, name: "obsolete", namespace: "shared" },
              ],
            },
            session,
            bindings: [],
          });
          expect(deleted.some((url) => url.includes("/configmaps/obsolete"))).toBe(true);
          expect(
            deleted.some(
              (url) => url.includes("/namespaces/shared") && !url.includes("/configmaps/"),
            ),
          ).toBe(false);
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

test.provider(
  "drift selection ignores undeclared fields on manifest and helm reads",
  () => {
    const legacy = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "legacy", namespace: "default" },
      spec: {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: { labels: { app: "web" } },
          spec: {
            containers: [
              {
                name: "app",
                image: "app:1",
                resources: { requests: { cpu: "0.1", memory: "1.5Gi" } },
              },
            ],
          },
        },
      },
    };
    const noted = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: "noted",
        namespace: "default",
        annotations: { app: "web" },
      },
      spec: {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: {
            labels: { app: "web" },
            annotations: { "prometheus.io/scrape": "true" },
          },
          spec: { containers: [{ name: "app", image: "app:1" }] },
        },
      },
    };
    const live: Record<string, unknown> = {
      legacy: {
        ...legacy,
        metadata: {
          ...legacy.metadata,
          uid: "u",
          resourceVersion: "9",
          annotations: { "deployment.kubernetes.io/revision": "3" },
        },
        spec: {
          replicas: 4,
          revisionHistoryLimit: 10,
          ...legacy.spec,
          template: {
            ...legacy.spec.template,
            spec: {
              containers: [
                {
                  name: "app",
                  image: "app:1",
                  imagePullPolicy: "IfNotPresent",
                  resources: { requests: { cpu: "100m", memory: "1536Mi" } },
                },
              ],
            },
          },
        },
      },
      noted: {
        ...noted,
        metadata: {
          ...noted.metadata,
          annotations: { app: "web", "deployment.kubernetes.io/revision": "3" },
        },
      },
      "noted-edit": {
        ...noted,
        metadata: { ...noted.metadata, name: "noted-edit", annotations: { app: "api" } },
      },
      "noted-drop": {
        ...noted,
        metadata: { ...noted.metadata, name: "noted-drop", annotations: {} },
        spec: {
          ...noted.spec,
          template: {
            ...noted.spec.template,
            metadata: { labels: { app: "web" } },
          },
        },
      },
      "template-edit": {
        ...noted,
        metadata: { ...noted.metadata, name: "template-edit" },
        spec: {
          ...noted.spec,
          template: {
            ...noted.spec.template,
            metadata: {
              labels: { app: "web" },
              annotations: { "prometheus.io/scrape": "false" },
            },
          },
        },
      },
      "template-drop": {
        ...noted,
        metadata: { ...noted.metadata, name: "template-drop" },
        spec: {
          ...noted.spec,
          template: {
            ...noted.spec.template,
            metadata: { labels: { app: "web" } },
          },
        },
      },
      "legacy-cm": {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "legacy-cm",
          namespace: "default",
          uid: "u",
          annotations: { "helm.sh/resource-policy": "keep" },
        },
        data: { message: "edited-out-of-band" },
      },
      "tracked-cm": {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "tracked-cm",
          namespace: "default",
          annotations: { app: "web", "meta.helm.sh/release-name": "probe" },
        },
        data: { message: "hello" },
      },
      "tracked-edit": {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name: "tracked-edit",
          namespace: "default",
          annotations: { app: "web" },
        },
        data: { message: "changed" },
      },
    };
    return serve(
      (request, response) => {
        const url = request.url ?? "";
        if (url.includes("/configmaps/gone")) {
          response.writeHead(404);
          response.end("");
          return;
        }
        const name = url.split("/").pop()?.split("?")[0] ?? "";
        const body = live[name];
        if (body === undefined) {
          response.writeHead(404);
          response.end("");
          return;
        }
        response.writeHead(200);
        response.end(JSON.stringify(body));
      },
      (endpoint) =>
        Effect.gen(function* () {
          const connection = connectionFor(endpoint);
          const manifest = yield* Provider.findProvider(Kubernetes.Manifest);
          const helm = yield* Provider.findProvider(Kubernetes.HelmChart);
          if (manifest.read === undefined || helm.read === undefined) {
            return yield* Effect.die("provider read is required");
          }
          const readManifest = (name: string, declared: KubernetesManifest) =>
            manifest.read!({
              id: name,
              fqn: name,
              instanceId: "i",
              olds: { cluster: connection, manifest: declared },
              output: {
                connection,
                apiVersion: "apps/v1",
                kind: "Deployment",
                name,
                namespace: "default",
                ref: {
                  apiVersion: "apps/v1",
                  kind: "Deployment",
                  name,
                  namespace: "default",
                },
                uid: "u",
              },
            });
          // Older state: no mask and no canonical hash. Defaults and an HPA
          // replica are not drift; a declared image edit is.
          const legacyRead = yield* readManifest("legacy", legacy);
          expect(drifted(legacyRead)).toBe(false);
          live.legacy = {
            ...(live.legacy as object),
            spec: {
              ...(legacy.spec as object),
              template: {
                metadata: { labels: { app: "web" } },
                spec: {
                  containers: [
                    {
                      name: "app",
                      image: "app:2",
                      resources: { requests: { cpu: "100m", memory: "1536Mi" } },
                    },
                  ],
                },
              },
            },
          };
          expect(drifted(yield* readManifest("legacy", legacy))).toBe(true);

          const controllerOnly = yield* manifest.read({
            id: "noted",
            fqn: "noted",
            instanceId: "i",
            olds: { cluster: connection, manifest: noted },
            output: {
              connection,
              apiVersion: "apps/v1",
              kind: "Deployment",
              name: "noted",
              namespace: "default",
              ref: {
                apiVersion: "apps/v1",
                kind: "Deployment",
                name: "noted",
                namespace: "default",
              },
              uid: "u",
              driftMask: driftMask(noted),
              baselineHash: yield* hashDriftSelection(noted, noted),
            },
          });
          expect(drifted(controllerOnly)).toBe(false);

          const editedAnn = yield* manifest.read({
            id: "noted-edit",
            fqn: "noted-edit",
            instanceId: "i",
            olds: {
              cluster: connection,
              manifest: { ...noted, metadata: { ...noted.metadata, name: "noted-edit" } },
            },
            output: {
              connection,
              apiVersion: "apps/v1",
              kind: "Deployment",
              name: "noted-edit",
              namespace: "default",
              ref: {
                apiVersion: "apps/v1",
                kind: "Deployment",
                name: "noted-edit",
                namespace: "default",
              },
              uid: "u",
              driftMask: driftMask({
                ...noted,
                metadata: { ...noted.metadata, name: "noted-edit" },
              }),
              baselineHash: yield* hashDriftSelection(
                { ...noted, metadata: { ...noted.metadata, name: "noted-edit" } },
                { ...noted, metadata: { ...noted.metadata, name: "noted-edit" } },
              ),
            },
          });
          expect(drifted(editedAnn)).toBe(true);

          const droppedAnn = yield* manifest.read({
            id: "noted-drop",
            fqn: "noted-drop",
            instanceId: "i",
            olds: {
              cluster: connection,
              manifest: { ...noted, metadata: { ...noted.metadata, name: "noted-drop" } },
            },
            output: {
              connection,
              apiVersion: "apps/v1",
              kind: "Deployment",
              name: "noted-drop",
              namespace: "default",
              ref: {
                apiVersion: "apps/v1",
                kind: "Deployment",
                name: "noted-drop",
                namespace: "default",
              },
              uid: "u",
              driftMask: driftMask({
                ...noted,
                metadata: { ...noted.metadata, name: "noted-drop" },
              }),
              baselineHash: yield* hashDriftSelection(
                { ...noted, metadata: { ...noted.metadata, name: "noted-drop" } },
                { ...noted, metadata: { ...noted.metadata, name: "noted-drop" } },
              ),
            },
          });
          expect(drifted(droppedAnn)).toBe(true);

          const templateDeclared = (name: string, annotations?: Record<string, string>) => ({
            ...noted,
            metadata: { ...noted.metadata, name },
            spec: {
              ...noted.spec,
              template: {
                ...noted.spec.template,
                metadata: {
                  labels: { app: "web" },
                  ...(annotations === undefined ? {} : { annotations }),
                },
              },
            },
          });
          const readMasked = (name: string, declared: KubernetesManifest) =>
            Effect.gen(function* () {
              return yield* manifest.read!({
                id: name,
                fqn: name,
                instanceId: "i",
                olds: { cluster: connection, manifest: declared },
                output: {
                  connection,
                  apiVersion: "apps/v1",
                  kind: "Deployment",
                  name,
                  namespace: "default",
                  ref: {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    name,
                    namespace: "default",
                  },
                  uid: "u",
                  driftMask: driftMask(declared),
                  baselineHash: yield* hashDriftSelection(declared, declared),
                },
              });
            });
          // Pod-template annotation edit and deletion, with the root annotation unchanged.
          expect(
            drifted(
              yield* readMasked(
                "template-edit",
                templateDeclared("template-edit", { "prometheus.io/scrape": "true" }),
              ),
            ),
          ).toBe(true);
          expect(
            drifted(
              yield* readMasked(
                "template-drop",
                templateDeclared("template-drop", { "prometheus.io/scrape": "true" }),
              ),
            ),
          ).toBe(true);

          const helmOutput = {
            connection,
            releaseName: "probe",
            namespace: "default",
            chart: chartDir,
            version: undefined,
            code: { hash: "older" },
            objects: [
              {
                apiVersion: "v1",
                kind: "ConfigMap",
                name: "legacy-cm",
                namespace: "default",
              },
            ],
          };
          const olderHelm = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: { cluster: connection, chart: chartDir },
            output: helmOutput,
          });
          expect(drifted(olderHelm)).toBe(false);
          const missingHelm = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: { cluster: connection, chart: chartDir },
            output: {
              ...helmOutput,
              objects: [
                ...helmOutput.objects,
                {
                  apiVersion: "v1",
                  kind: "ConfigMap",
                  name: "gone",
                  namespace: "default",
                },
              ],
            },
          });
          expect(drifted(missingHelm)).toBe(true);

          const tracked = {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: {
              name: "tracked-cm",
              namespace: "default",
              annotations: { app: "web" },
            },
            data: { message: "hello" },
          };
          const trackedEdit = {
            ...tracked,
            metadata: { ...tracked.metadata, name: "tracked-edit" },
          };
          const helmObject = (name: string, declared: Record<string, unknown>) =>
            Effect.gen(function* () {
              return {
                apiVersion: "v1",
                kind: "ConfigMap",
                name,
                namespace: "default",
                driftMask: driftMask(declared),
                baselineHash: yield* hashDriftSelection(declared, declared),
              };
            });
          // A stored Helm selection ignores a controller annotation and
          // notices a declared data edit. Reads stay GET-only.
          const stableHelm = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: { cluster: connection, chart: chartDir },
            output: {
              ...helmOutput,
              objects: [yield* helmObject("tracked-cm", tracked)],
            },
          });
          expect(drifted(stableHelm)).toBe(false);
          const editedHelm = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: { cluster: connection, chart: chartDir },
            output: {
              ...helmOutput,
              objects: [yield* helmObject("tracked-edit", trackedEdit)],
            },
          });
          expect(drifted(editedHelm)).toBe(true);
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);

const openDrift = <E, R>(
  objects: Record<string, unknown>,
  check: (input: {
    connection: Connection;
    manifest: Provider.ProviderService<Kubernetes.Manifest>;
    helm: Provider.ProviderService<Kubernetes.HelmChart>;
  }) => Effect.Effect<void, E, R>,
) =>
  serve(
    (request, response) => {
      const url = request.url ?? "";
      const name = url.split("/").pop()?.split("?")[0] ?? "";
      const body = objects[name];
      if (body === undefined) {
        response.writeHead(404);
        response.end("");
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify(body));
    },
    (endpoint) =>
      Effect.gen(function* () {
        const connection = connectionFor(endpoint);
        const manifest = yield* Provider.findProvider(Kubernetes.Manifest);
        const helm = yield* Provider.findProvider(Kubernetes.HelmChart);
        if (manifest.read === undefined || helm.read === undefined) {
          return yield* Effect.die("provider read is required");
        }
        yield* check({ connection, manifest, helm });
      }),
  );

type AppDeployment = KubernetesManifest & {
  metadata: {
    name: string;
    namespace: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec: {
    replicas?: number;
    revisionHistoryLimit?: number;
    selector?: { matchLabels: Record<string, string> };
    template: {
      metadata: { labels?: Record<string, string>; annotations?: Record<string, string> };
      spec: Record<string, unknown>;
    };
  };
};

const deploymentOutput = (
  connection: Connection,
  name: string,
  declared: KubernetesManifest,
  stored?: { driftMask: unknown; baselineHash: string },
) => ({
  id: name,
  fqn: name,
  instanceId: "i" as const,
  olds: { cluster: connection, manifest: declared },
  output: {
    connection,
    apiVersion: "apps/v1",
    kind: "Deployment",
    name,
    namespace: "default",
    ref: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      name,
      namespace: "default",
    },
    uid: "u",
    ...stored,
  },
});

const appDeployment = (name: string, spec: AppDeployment["spec"]): AppDeployment => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name, namespace: "default" },
  spec,
});

const driftTags = { tags: ["provider:kubernetes", "local"] as const, timeout: 20_000 };

test.provider(
  "pre-baseline Manifest read ignores an HPA replica and canonical quantities",
  () => {
    const declared = appDeployment("hpa", {
      selector: { matchLabels: { app: "web" } },
      template: {
        metadata: { labels: { app: "web" } },
        spec: {
          containers: [
            {
              name: "app",
              image: "app:1",
              resources: { requests: { cpu: "0.1", memory: "1.5Gi" } },
            },
          ],
        },
      },
    });
    return openDrift(
      {
        hpa: {
          ...declared,
          metadata: {
            ...declared.metadata,
            uid: "u",
            annotations: { "deployment.kubernetes.io/revision": "3" },
          },
          spec: {
            replicas: 4,
            revisionHistoryLimit: 10,
            ...declared.spec,
            template: {
              metadata: { labels: { app: "web" } },
              spec: {
                containers: [
                  {
                    name: "app",
                    image: "app:1",
                    imagePullPolicy: "IfNotPresent",
                    resources: { requests: { cpu: "100m", memory: "1536Mi" } },
                  },
                ],
              },
            },
          },
        },
      },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          const read = yield* manifest.read(deploymentOutput(connection, "hpa", declared));
          expect(drifted(read)).toBe(false);
        }),
    );
  },
  driftTags,
);

test.provider(
  "pre-baseline Manifest read drifts on a declared image edit",
  () => {
    const declared = appDeployment("edited", {
      selector: { matchLabels: { app: "web" } },
      template: {
        metadata: { labels: { app: "web" } },
        spec: { containers: [{ name: "app", image: "app:1" }] },
      },
    });
    return openDrift(
      {
        edited: {
          ...declared,
          spec: {
            ...declared.spec,
            template: {
              metadata: { labels: { app: "web" } },
              spec: { containers: [{ name: "app", image: "app:2" }] },
            },
          },
        },
      },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          expect(
            drifted(yield* manifest.read(deploymentOutput(connection, "edited", declared))),
          ).toBe(true);
        }),
    );
  },
  driftTags,
);

test.provider(
  "declared replica edit drifts",
  () => {
    const declared = appDeployment("pinned", {
      replicas: 2,
      selector: { matchLabels: { app: "web" } },
      template: {
        metadata: { labels: { app: "web" } },
        spec: { containers: [{ name: "app", image: "app:1" }] },
      },
    });
    return openDrift(
      { pinned: { ...declared, spec: { ...declared.spec, replicas: 9 } } },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          const stored = {
            driftMask: driftMask(declared),
            baselineHash: yield* hashDriftSelection(declared, declared),
          };
          expect(
            drifted(yield* manifest.read(deploymentOutput(connection, "pinned", declared, stored))),
          ).toBe(true);
        }),
    );
  },
  driftTags,
);

test.provider(
  "root annotation edit drifts and root annotation deletion drifts",
  () => {
    const declared = (name: string) =>
      appDeployment(name, {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: { labels: { app: "web" } },
          spec: { containers: [{ name: "app", image: "app:1" }] },
        },
      });
    const edited = {
      ...declared("root-edit"),
      metadata: { name: "root-edit", namespace: "default", annotations: { app: "web" } },
    };
    const dropped = {
      ...declared("root-drop"),
      metadata: { name: "root-drop", namespace: "default", annotations: { app: "web" } },
    };
    return openDrift(
      {
        "root-edit": {
          ...edited,
          metadata: { ...edited.metadata, annotations: { app: "api" } },
        },
        "root-drop": { ...dropped, metadata: { ...dropped.metadata, annotations: {} } },
      },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          const readStored = (name: string, body: AppDeployment) =>
            Effect.gen(function* () {
              return yield* manifest.read!(
                deploymentOutput(connection, name, body, {
                  driftMask: driftMask(body),
                  baselineHash: yield* hashDriftSelection(body, body),
                }),
              );
            });
          expect(drifted(yield* readStored("root-edit", edited))).toBe(true);
          expect(drifted(yield* readStored("root-drop", dropped))).toBe(true);
        }),
    );
  },
  driftTags,
);

test.provider(
  "pod-template annotation edit drifts and pod-template annotation deletion drifts",
  () => {
    const declared = (name: string): AppDeployment => ({
      ...appDeployment(name, {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: {
            labels: { app: "web" },
            annotations: { "prometheus.io/scrape": "true" },
          },
          spec: { containers: [{ name: "app", image: "app:1" }] },
        },
      }),
      metadata: { name, namespace: "default", annotations: { app: "web" } },
    });
    const templateOf = (
      name: string,
      annotations: Record<string, string> | undefined,
    ): AppDeployment => {
      const body = declared(name);
      return {
        ...body,
        spec: {
          ...body.spec,
          template: {
            metadata: {
              labels: { app: "web" },
              ...(annotations === undefined ? {} : { annotations }),
            },
            spec: { containers: [{ name: "app", image: "app:1" }] },
          },
        },
      };
    };
    return openDrift(
      {
        "template-edit": templateOf("template-edit", { "prometheus.io/scrape": "false" }),
        "template-drop": templateOf("template-drop", undefined),
      },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          const readStored = (name: string) =>
            Effect.gen(function* () {
              const body = declared(name);
              return yield* manifest.read!(
                deploymentOutput(connection, name, body, {
                  driftMask: driftMask(body),
                  baselineHash: yield* hashDriftSelection(body, body),
                }),
              );
            });
          expect(drifted(yield* readStored("template-edit"))).toBe(true);
          expect(drifted(yield* readStored("template-drop"))).toBe(true);
        }),
    );
  },
  driftTags,
);

test.provider(
  "controller-only annotation does not drift",
  () => {
    const declared = {
      ...appDeployment("noted", {
        selector: { matchLabels: { app: "web" } },
        template: {
          metadata: { labels: { app: "web" } },
          spec: { containers: [{ name: "app", image: "app:1" }] },
        },
      }),
      metadata: { name: "noted", namespace: "default", annotations: { app: "web" } },
    };
    return openDrift(
      {
        noted: {
          ...declared,
          metadata: {
            ...declared.metadata,
            annotations: { app: "web", "deployment.kubernetes.io/revision": "4" },
          },
        },
      },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          const read = yield* manifest.read(
            deploymentOutput(connection, "noted", declared, {
              driftMask: driftMask(declared),
              baselineHash: yield* hashDriftSelection(declared, declared),
            }),
          );
          expect(drifted(read)).toBe(false);
        }),
    );
  },
  driftTags,
);

test.provider(
  "reversed initContainers are not drift",
  () => {
    const declared = appDeployment("ordered", {
      selector: { matchLabels: { app: "web" } },
      template: {
        metadata: { labels: { app: "web" } },
        spec: {
          initContainers: [
            { name: "a", image: "a:1" },
            { name: "b", image: "b:1" },
          ],
          containers: [{ name: "app", image: "app:1" }],
        },
      },
    });
    return openDrift(
      {
        ordered: {
          ...declared,
          spec: {
            ...declared.spec,
            template: {
              metadata: { labels: { app: "web" } },
              spec: {
                initContainers: [
                  { name: "b", image: "b:1" },
                  { name: "a", image: "a:1" },
                ],
                containers: [{ name: "app", image: "app:1" }],
              },
            },
          },
        },
      },
      ({ connection, manifest }) =>
        Effect.gen(function* () {
          if (manifest.read === undefined) return;
          const read = yield* manifest.read(
            deploymentOutput(connection, "ordered", declared, {
              driftMask: driftMask(declared),
              baselineHash: yield* hashDriftSelection(declared, declared),
            }),
          );
          expect(drifted(read)).toBe(false);
        }),
    );
  },
  driftTags,
);

test.provider(
  "pre-baseline HelmChart read ignores an out-of-band edit",
  () =>
    openDrift(
      {
        "legacy-cm": {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "legacy-cm", namespace: "default" },
          data: { message: "edited-out-of-band" },
        },
      },
      ({ connection, helm }) =>
        Effect.gen(function* () {
          if (helm.read === undefined) return;
          const read = yield* helm.read({
            id: "Chart",
            fqn: "Chart",
            instanceId: "i",
            olds: { cluster: connection, chart: chartDir },
            output: {
              connection,
              releaseName: "probe",
              namespace: "default",
              chart: chartDir,
              version: undefined,
              code: { hash: "older" },
              objects: [
                {
                  apiVersion: "v1",
                  kind: "ConfigMap",
                  name: "legacy-cm",
                  namespace: "default",
                },
              ],
            },
          });
          expect(drifted(read)).toBe(false);
        }),
    ),
  driftTags,
);

test.provider(
  "missing Helm object drifts",
  () =>
    openDrift({}, ({ connection, helm }) =>
      Effect.gen(function* () {
        if (helm.read === undefined) return;
        const read = yield* helm.read({
          id: "Chart",
          fqn: "Chart",
          instanceId: "i",
          olds: { cluster: connection, chart: chartDir },
          output: {
            connection,
            releaseName: "probe",
            namespace: "default",
            chart: chartDir,
            version: undefined,
            code: { hash: "older" },
            objects: [{ apiVersion: "v1", kind: "ConfigMap", name: "gone", namespace: "default" }],
          },
        });
        expect(drifted(read)).toBe(true);
      }),
    ),
  driftTags,
);

test.provider(
  "one-shot job names follow unwrapped secret env values",
  () => {
    const applied: { method: string; url: string; body: string }[] = [];
    return serve(
      (request, response) => {
        onBody(request, (body) => {
          applied.push({ method: request.method ?? "", url: request.url ?? "", body });
          response.writeHead(200);
          response.end(
            request.method === "DELETE" ? "" : JSON.stringify({ metadata: { uid: "u" } }),
          );
        });
      },
      (endpoint) =>
        Effect.gen(function* () {
          const job = yield* Provider.findProvider(Kubernetes.Job);
          if (job.reconcile === undefined) {
            return yield* Effect.die("provider reconcile is required");
          }
          const connection = connectionFor(endpoint);
          const news = (token: string) => ({
            cluster: connection,
            name: "rotate",
            image: "busybox:1",
            env: { TOKEN: Redacted.make(token) },
          });
          const first = yield* job.reconcile({
            id: "rotate",
            fqn: "rotate",
            instanceId: "i",
            news: news("s3cr3t-a"),
            olds: undefined,
            output: undefined,
            session,
            bindings: [],
          });
          const again = yield* job.reconcile({
            id: "rotate",
            fqn: "rotate",
            instanceId: "i",
            news: news("s3cr3t-a"),
            olds: news("s3cr3t-a"),
            output: first,
            session,
            bindings: [],
          });
          const rotated = yield* job.reconcile({
            id: "rotate",
            fqn: "rotate",
            instanceId: "i",
            news: news("s3cr3t-b"),
            olds: news("s3cr3t-a"),
            output: first,
            session,
            bindings: [],
          });
          expect(again.jobName).toBe(first.jobName);
          expect(rotated.jobName).not.toBe(first.jobName);
          const jobPatches = applied.filter(
            (call) => call.method === "PATCH" && call.url.includes("/jobs/"),
          );
          expect(jobPatches.map((call) => call.url.split("/").pop()?.split("?")[0])).toEqual([
            first.jobName,
            first.jobName,
            rotated.jobName,
          ]);
          expect(jobPatches[0]?.body).toContain("s3cr3t-a");
          expect(jobPatches[2]?.body).toContain("s3cr3t-b");
          expect(jobPatches.every((call) => !call.body.includes("<redacted>"))).toBe(true);
          expect(JSON.stringify(first.kubernetesObjects)).not.toContain("s3cr3t");
          expect(
            applied.some(
              (call) => call.method === "DELETE" && call.url.includes(`/jobs/${first.jobName}`),
            ),
          ).toBe(true);
        }),
    );
  },
  { tags: ["provider:kubernetes", "local"], timeout: 20_000 },
);
