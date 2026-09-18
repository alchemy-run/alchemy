import {
  discoverManagementNodes,
  makeLocalFleetManagement,
  privateNodeEndpoint,
  proveRootReload,
  type ManagementGraph,
} from "@/Celld/Management.ts";
import type { Store, StoredObject } from "@/Celld/FleetStorage.ts";
import {
  APPLICATION_OPERATOR_CLASSES,
  prepareApplicationGraph,
} from "@/Celld/ApplicationGraph.ts";
import {
  prepareDeployment,
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
} from "@/Celld/Deployment.ts";
import { canonicalJson } from "@/Celld/Deployment/Objects.ts";
import { describe, expect, it } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { createHash, createHmac } from "node:crypto";

const connection = { bucket: { uri: "s3://test-cells" } };
const version = "0123456789abcdef";
const graph: ManagementGraph = {
  root: {
    pointer: {
      script_name: "root",
      version,
      prefix: `deploy/root/${version}`,
      rollout: { percent: 100 },
    },
    manifest: {
      version,
      script_name: "root",
      do_classes: [],
      sqlite_classes: [],
      modules: [],
      raw_metadata: {},
    },
  },
  workers: [],
};
const fixture = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.sync(() => {
    const objects = new Map<string, StoredObject>();
    const put = (key: string, value: unknown) =>
      objects.set(key, {
        body: new TextEncoder().encode(JSON.stringify(value)),
        etag: "test",
      });
    const lease = (
      node: string,
      addr = "10.0.0.1:8081",
      expires_ms = now + 60_000,
    ) => ({ node, addr, expires_ms, peer_protocol: 5 });
    put("nodes/session-a.json", lease("session-a"));
    put("nodes/session-b.json", lease("session-b", "10.0.0.2:8081"));
    put("fleet/peer-auth.json", { version: 1, key: "07".repeat(32) });
    put("deploy/current.json", graph.root.pointer);
    put("deploy/root/current.json", graph.root.pointer);
    put(`${graph.root.pointer.prefix}/manifest.json`, graph.root.manifest);
    const store: Store = {
      get: (key) => Effect.sync(() => objects.get(key)),
      list: (prefix) =>
        Effect.sync(() =>
          [...objects]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, etag: value.etag })),
        ),
      put: () => Effect.die("Management must not publish objects"),
      delete: () => Effect.die("Management must not delete objects"),
    };
    return { store, objects, put, lease, now };
  });
});

const lockedFixture = (crons: readonly string[] = ["* * * * *"]) =>
  Effect.gen(function* () {
    const memory = yield* fixture;
    const sourceRoot = yield* prepareDeployment({
      scriptName: "root",
      mainModule: "main.js",
      modules: [
        {
          name: "main.js",
          content: "export default { fetch() { return new Response('root') } }",
        },
      ],
      metadata: {},
      doClasses: [],
      sqliteClasses: [],
      crons,
    });
    const sourceWorker = yield* prepareDeployment({
      scriptName: "worker",
      mainModule: "main.js",
      modules: [
        {
          name: "main.js",
          content:
            "export default { fetch() { return new Response('worker') } }",
        },
      ],
      metadata: {},
      doClasses: [],
      sqliteClasses: [],
      queueConsumers: [
        {
          queue: "jobs",
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
        },
      ],
    });
    const prepared = yield* prepareApplicationGraph(sourceRoot, [sourceWorker]);
    const complete: ManagementGraph = {
      root: prepared.root,
      workers: prepared.workers,
    };
    return yield* Effect.sync(() => {
      const hash = (value: unknown) =>
        createHash("sha256").update(canonicalJson(value)).digest("hex");
      const seal = (value: ManagementGraph) => {
        const owner = {
          stack: "test",
          stage: "test",
          fqn: "Application",
          instanceId: "instance",
        };
        const transactionId = "activation-test";
        const all = [value.root, ...value.workers];
        const fingerprint = hash({
          owner,
          root: value.root.pointer,
          manifests: all.map((item) => item.manifest),
          priorRevision: null,
          adopt: false,
        });
        const lock = { owner, transactionId, fingerprint };
        const keys = ["deploy/current.json"];
        memory.put("deploy/current.json", value.root.pointer);
        for (const item of all) {
          const pointerKey = `deploy/${item.pointer.script_name}/current.json`;
          const manifestKey = `${item.pointer.prefix}/manifest.json`;
          memory.put(pointerKey, item.pointer);
          memory.put(manifestKey, item.manifest);
          keys.push(pointerKey, manifestKey);
          for (const consumer of item.manifest.queue_consumers ?? []) {
            const key = `deploy/queues/${consumer.queue}/consumer.json`;
            memory.put(key, {
              schema_version: 1,
              queue: consumer.queue,
              consumer: {
                script_name: item.pointer.script_name,
                version: item.pointer.version,
                prefix: item.pointer.prefix,
              },
            });
            keys.push(key);
          }
        }
        const receipt = {
          schemaVersion: 1,
          owner,
          transactionId,
          revision: hash({ fingerprint, transactionId }),
          root: value.root.pointer,
          workers: value.workers.map((worker) => worker.pointer),
          objects: keys.map((key) => {
            const object = memory.objects.get(key)!;
            return {
              key,
              body: new TextDecoder().decode(object.body),
              etag: object.etag,
            };
          }),
        };
        memory.put(APPLICATION_LOCK_KEY, lock);
        memory.put(APPLICATION_RECEIPT_KEY, receipt);
        return { lock, receipt };
      };
      for (const source of [sourceRoot, sourceWorker])
        memory.objects.set(source.candidate.key, {
          body: source.candidate.body,
          etag: "source",
        });
      const publication = seal(complete);
      return {
        ...memory,
        ...publication,
        graph: complete,
        sourceRoot,
        sourceWorker,
        seal,
        hash,
      };
    });
  });

const adminClient = (
  calls: string[],
  onCall?: (url: URL) => void,
  activeGraph: ManagementGraph = graph,
) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.host}${url.pathname}`);
      onCall?.(url);
      expect(url.hostname.startsWith("10.0.0.")).toBe(true);
      if (url.pathname === "/reload") {
        expect(request.method).toBe("POST");
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            outcome: "adopted",
            generation: 2,
            version: activeGraph.root.pointer.version,
            prefix: activeGraph.root.pointer.prefix,
          }),
        );
      }
      expect(url.pathname).toBe("/state");
      expect(request.method).toBe("GET");
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          deployment: {
            generation: 2,
            version: activeGraph.root.pointer.version,
            prefix: activeGraph.root.pointer.prefix,
            draining: [],
            swapping: 0,
            cells: {},
          },
        }),
      );
    }),
  );

describe("Celld private management", () => {
  it.live(
    "forced root proof waits for delayed swaps without repeating POST reload",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        yield* Effect.sync(() => memory.objects.delete("nodes/session-b.json"));
        let posts = 0;
        let reads = 0;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.method === "POST") {
              posts++;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  ok: true,
                  outcome: "adopted",
                  generation: 2,
                  version,
                  prefix: graph.root.pointer.prefix,
                }),
              );
            }
            reads++;
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                deployment: {
                  generation: 2,
                  version,
                  prefix: graph.root.pointer.prefix,
                  draining: [],
                  cells: {},
                  swapping: reads < 3 ? 1 : 0,
                },
              }),
            );
          }),
        );
        const proof = yield* proveRootReload(memory.store, client, graph);
        expect(posts).toBe(1);
        expect(reads).toBe(3);
        expect(proof.assurance).toBe("forced-root-reload");
        expect(proof.namedAdoption).toBe("not-observed");
        expect(proof.nodes[0]?.stateReads).toBe(3);
        expect(proof.nodes[0]?.outcome).toBe("adopted");
        expect(proof.snapshots.map((snapshot) => snapshot.key).sort()).toEqual(
          [
            "deploy/current.json",
            `deploy/root/${version}/manifest.json`,
            "deploy/root/current.json",
          ].sort(),
        );
        expect(
          proof.snapshots.every(
            (snapshot) =>
              snapshot.etag === "test" &&
              /^[a-f0-9]{64}$/.test(snapshot.sha256),
          ),
        ).toBe(true);
      }),
  );

  it.live(
    "pending swaps exhaust exactly ten GET observations and remain distinct from reload failure",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        yield* Effect.sync(() => memory.objects.delete("nodes/session-b.json"));
        let posts = 0;
        let reads = 0;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.method === "POST") {
              posts++;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  ok: true,
                  outcome: "adopted",
                  generation: 2,
                  version,
                  prefix: graph.root.pointer.prefix,
                }),
              );
            }
            reads++;
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                deployment: {
                  generation: 2,
                  version,
                  prefix: graph.root.pointer.prefix,
                  draining: [],
                  cells: {},
                  swapping: 1,
                },
              }),
            );
          }),
        );
        const result = yield* Effect.result(
          proveRootReload(memory.store, client, graph),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.reason).toBe("swap-pending");
        expect(posts).toBe(1);
        expect(reads).toBe(10);
      }),
  );

  it.effect(
    "reload rejection, failed state observation and root drift have distinct errors and no retries",
    () =>
      Effect.gen(function* () {
        for (const mode of [
          "reload-failed",
          "state-unavailable",
          "drift",
        ] as const) {
          const memory = yield* fixture;
          yield* Effect.sync(() =>
            memory.objects.delete("nodes/session-b.json"),
          );
          let posts = 0;
          let reads = 0;
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              if (request.method === "POST") {
                posts++;
                return HttpClientResponse.fromWeb(
                  request,
                  mode === "reload-failed"
                    ? Response.json({ error: "Build failed" }, { status: 422 })
                    : Response.json({
                        ok: true,
                        outcome: "adopted",
                        generation: 2,
                        version,
                        prefix: graph.root.pointer.prefix,
                      }),
                );
              }
              reads++;
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  mode === "state-unavailable"
                    ? { error: "actor_stopped" }
                    : {
                        deployment: {
                          generation: 3,
                          version,
                          prefix: graph.root.pointer.prefix,
                          draining: [],
                          cells: {},
                          swapping: 0,
                        },
                      },
                ),
              );
            }),
          );
          const result = yield* Effect.result(
            proveRootReload(memory.store, client, graph),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.reason).toBe(mode);
          expect(posts).toBe(1);
          expect(reads).toBe(mode === "reload-failed" ? 0 : 1);
        }
      }),
  );

  it.effect(
    "proof rejects changed ETags or bytes even when graph values compare equal",
    () =>
      Effect.gen(function* () {
        for (const change of ["etag", "body"] as const) {
          const memory = yield* fixture;
          yield* Effect.sync(() =>
            memory.objects.delete("nodes/session-b.json"),
          );
          const calls: string[] = [];
          const client = adminClient(calls, (url) => {
            if (url.pathname === "/state") {
              const object = memory.objects.get("deploy/current.json")!;
              memory.objects.set(
                "deploy/current.json",
                change === "etag"
                  ? { ...object, etag: "replaced" }
                  : {
                      ...object,
                      body: new TextEncoder().encode(
                        `${new TextDecoder().decode(object.body)}\n`,
                      ),
                    },
              );
            }
          });
          const result = yield* Effect.result(
            proveRootReload(memory.store, client, graph),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.reason).toBe("drift");
          expect(calls).toHaveLength(2);
        }
      }),
  );
  it.effect(
    "discovers exact live session keys and ignores expired leases",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        yield* Effect.sync(() =>
          memory.put(
            "nodes/expired.json",
            memory.lease("expired", "10.0.0.3:8081", memory.now - 1),
          ),
        );
        const nodes = yield* discoverManagementNodes(memory.store, {
          minimumNodes: 2,
        });
        expect(nodes).toEqual([
          { session: "session-a", endpoint: "http://10.0.0.1:8081" },
          { session: "session-b", endpoint: "http://10.0.0.2:8081" },
        ]);
      }),
  );

  it.effect(
    "rejects mismatched sessions, old protocols, duplicate addresses and insufficient membership",
    () =>
      Effect.gen(function* () {
        for (const lease of [
          { node: "wrong", addr: "10.0.0.1:8081", peer_protocol: 5 },
          { node: "session-a", addr: "10.0.0.1:8081", peer_protocol: 4 },
          { node: "session-a", addr: "10.0.0.2:8081", peer_protocol: 5 },
        ]) {
          const memory = yield* fixture;
          yield* Effect.sync(() =>
            memory.put("nodes/session-a.json", {
              ...lease,
              expires_ms: memory.now + 60_000,
            }),
          );
          expect(
            Result.isFailure(
              yield* Effect.result(discoverManagementNodes(memory.store)),
            ),
          ).toBe(true);
        }
        const memory = yield* fixture;
        expect(
          Result.isFailure(
            yield* Effect.result(
              discoverManagementNodes(memory.store, { minimumNodes: 3 }),
            ),
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "rejects public, DNS, metadata, loopback, alternate port and URL-shaped addresses",
    () =>
      Effect.gen(function* () {
        for (const address of [
          "8.8.8.8:8081",
          "127.0.0.1:8081",
          "169.254.169.254:8081",
          "localhost:8081",
          "10.0.0.1:8080",
          "http://10.0.0.1:8081",
          "10.0.0.1:8081/path",
          "010.0.0.1:8081",
          "172.32.0.1:8081",
          "10.0.0.999:8081",
          "[::1]:8081",
        ]) {
          expect(
            Result.isFailure(
              yield* Effect.result(privateNodeEndpoint(address)),
            ),
          ).toBe(true);
        }
        expect(yield* privateNodeEndpoint("172.31.0.1:8081")).toBe(
          "http://172.31.0.1:8081",
        );
        expect(yield* privateNodeEndpoint("192.168.1.1:8081")).toBe(
          "http://192.168.1.1:8081",
        );
      }),
  );

  it.effect(
    "reloads all live nodes through generated admin operations and reports only root evidence",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        const calls: string[] = [];
        const management = makeLocalFleetManagement(
          () => Effect.succeed(memory.store),
          adminClient(calls),
        );
        const result = yield* management.reload(connection, graph);
        expect(result.assurance).toBe("root-identity-only");
        expect(result.nodes).toHaveLength(2);
        expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2);
        expect(calls.filter((call) => call.startsWith("GET"))).toHaveLength(2);
      }),
  );

  it.effect(
    "activation requires the existing publisher lock before any native reload",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        const calls: string[] = [];
        const result = yield* Effect.result(
          makeLocalFleetManagement(
            () => Effect.succeed(memory.store),
            adminClient(calls),
          ).activate(connection, graph),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.reason).toBe("drift");
        expect(calls).toHaveLength(0);
      }),
  );

  it.effect(
    "locked activation infers graph installation and explicitly leaves cron delivery unobserved",
    () =>
      Effect.gen(function* () {
        for (const crons of [["* * * * *"], ["*/5 * * * *"]]) {
          const memory = yield* lockedFixture(crons);
          const calls: string[] = [];
          const result = yield* makeLocalFleetManagement(
            () => Effect.succeed(memory.store),
            adminClient(calls, undefined, memory.graph),
          ).activate(connection, memory.graph);
          expect(result.assurance).toBe("locked-graph-generation");
          expect(result.cronDelivery).toBe("not-observed");
          expect(result.publicationRevision).toBe(memory.receipt.revision);
          expect(result.proof.nodes).toHaveLength(2);
          expect(result.proof.namedAdoption).toBe("not-observed");
          expect(
            result.proof.snapshots.map((snapshot) => snapshot.key),
          ).toEqual(
            expect.arrayContaining([
              APPLICATION_LOCK_KEY,
              APPLICATION_RECEIPT_KEY,
              memory.sourceRoot.candidate.key,
              memory.sourceWorker.candidate.key,
              "deploy/queues/jobs/consumer.json",
            ]),
          );
          expect(JSON.stringify(result)).not.toContain("fingerprint");
          expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(
            2,
          );
          expect(calls).toHaveLength(4);
        }
      }),
  );

  it.effect(
    "activation refuses absent, mismatched, incomplete or malformed locked inputs before reload",
    () =>
      Effect.gen(function* () {
        for (const mode of [
          "lock",
          "receipt",
          "owner",
          "transaction",
          "fingerprint",
          "receipt-root",
          "receipt-workers",
          "receipt-entry",
          "marker",
          "marker-absent",
          "marker-revision",
          "marker-entry",
          "candidate",
          "candidate-content",
          "candidate-cron",
          "service-binding",
          "operator-class-missing",
          "operator-sqlite-missing",
          "operator-feature-missing",
          "operator-class-duplicate",
          "extra-class",
        ] as const) {
          const memory = yield* lockedFixture();
          const requested = yield* Effect.sync(() => {
            if (mode === "lock") memory.objects.delete(APPLICATION_LOCK_KEY);
            if (mode === "receipt")
              memory.objects.delete(APPLICATION_RECEIPT_KEY);
            if (mode === "owner")
              memory.put(APPLICATION_LOCK_KEY, {
                ...memory.lock,
                owner: { ...memory.lock.owner, instanceId: "other" },
              });
            if (mode === "transaction")
              memory.put(APPLICATION_LOCK_KEY, {
                ...memory.lock,
                transactionId: "other",
              });
            if (mode === "fingerprint")
              memory.put(APPLICATION_LOCK_KEY, {
                ...memory.lock,
                fingerprint: "0".repeat(64),
              });
            if (mode === "receipt-root")
              memory.put(APPLICATION_RECEIPT_KEY, {
                ...memory.receipt,
                root: memory.sourceRoot.pointer,
              });
            if (mode === "receipt-workers")
              memory.put(APPLICATION_RECEIPT_KEY, {
                ...memory.receipt,
                workers: [],
              });
            if (mode === "receipt-entry")
              memory.put(APPLICATION_RECEIPT_KEY, {
                ...memory.receipt,
                objects: memory.receipt.objects.filter(
                  (object) => object.key !== "deploy/worker/current.json",
                ),
              });
            if (mode === "candidate")
              memory.objects.delete(memory.sourceWorker.candidate.key);
            if (mode === "candidate-content")
              memory.put(memory.sourceWorker.candidate.key, {
                ...memory.sourceWorker.manifest,
                crons: ["* * * * *"],
              });
            if (
              [
                "marker",
                "marker-absent",
                "marker-revision",
                "marker-entry",
                "candidate-cron",
                "service-binding",
                "operator-class-missing",
                "operator-sqlite-missing",
                "operator-feature-missing",
                "operator-class-duplicate",
                "extra-class",
              ].includes(mode)
            ) {
              const candidates = [memory.sourceRoot, memory.sourceWorker].map(
                (source) => ({
                  scriptName: source.scriptName,
                  key: source.candidate.key,
                }),
              );
              if (mode === "marker-entry") candidates.pop();
              const raw_metadata = {
                alchemy_application: {
                  schemaVersion: mode === "marker" ? 2 : 1,
                  operatorClasses: APPLICATION_OPERATOR_CLASSES,
                  revision:
                    mode === "marker-revision"
                      ? "0".repeat(64)
                      : memory.hash(candidates),
                  candidates,
                },
                bindings:
                  mode === "service-binding"
                    ? []
                    : [
                        {
                          type: "service",
                          name: "__ALCHEMY_APP_WORKER_0",
                          service: "worker",
                        },
                      ],
              };
              const changed: ManagementGraph = {
                ...memory.graph,
                root: {
                  ...memory.graph.root,
                  manifest: {
                    ...memory.graph.root.manifest,
                    raw_metadata:
                      mode === "marker-absent"
                        ? { bindings: raw_metadata.bindings }
                        : raw_metadata,
                    ...(mode === "candidate-cron"
                      ? { crons: ["0 * * * *"] }
                      : {}),
                    ...(mode === "operator-class-missing"
                      ? { do_classes: [] }
                      : {}),
                    ...(mode === "operator-sqlite-missing"
                      ? { sqlite_classes: [] }
                      : {}),
                    ...(mode === "operator-feature-missing"
                      ? { required_features: ["cron-v1", "kv-v1", "queues-v1"] }
                      : {}),
                    ...(mode === "operator-class-duplicate"
                      ? {
                          do_classes: [
                            ...APPLICATION_OPERATOR_CLASSES,
                            "__D1Database",
                          ],
                        }
                      : {}),
                    ...(mode === "extra-class"
                      ? {
                          do_classes: [
                            ...APPLICATION_OPERATOR_CLASSES,
                            "Unstaged",
                          ],
                        }
                      : {}),
                  },
                },
              };
              memory.seal(changed);
              return changed;
            }
            return memory.graph;
          });
          const calls: string[] = [];
          const result = yield* Effect.result(
            makeLocalFleetManagement(
              () => Effect.succeed(memory.store),
              adminClient(calls, undefined, requested),
            ).activate(connection, requested),
          );
          expect(Result.isFailure(result)).toBe(true);
          expect(calls).toHaveLength(0);
        }
      }),
  );

  it.effect(
    "activation brackets lock, receipt and source candidate ETags and exact bytes around reload",
    () =>
      Effect.gen(function* () {
        for (const target of ["lock", "receipt", "candidate"] as const) {
          for (const change of ["etag", "body", "delete"] as const) {
            const memory = yield* lockedFixture();
            yield* Effect.sync(() =>
              memory.objects.delete("nodes/session-b.json"),
            );
            const key =
              target === "lock"
                ? APPLICATION_LOCK_KEY
                : target === "receipt"
                  ? APPLICATION_RECEIPT_KEY
                  : memory.sourceWorker.candidate.key;
            const calls: string[] = [];
            const client = adminClient(
              calls,
              (url) => {
                if (url.pathname !== "/state") return;
                const object = memory.objects.get(key)!;
                if (change === "delete") memory.objects.delete(key);
                else
                  memory.objects.set(
                    key,
                    change === "etag"
                      ? { ...object, etag: "replaced" }
                      : {
                          ...object,
                          body: new TextEncoder().encode(
                            `${new TextDecoder().decode(object.body)}\n`,
                          ),
                        },
                  );
              },
              memory.graph,
            );
            const result = yield* Effect.result(
              makeLocalFleetManagement(
                () => Effect.succeed(memory.store),
                client,
              ).activate(connection, memory.graph),
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure.reason).toBe("drift");
            expect(calls).toHaveLength(2);
          }
        }
      }),
  );

  it.effect(
    "locked activation still rejects native build failures, generation drift and membership changes",
    () =>
      Effect.gen(function* () {
        for (const mode of [
          "reload-failed",
          "drift",
          "membership-changed",
        ] as const) {
          const memory = yield* lockedFixture();
          yield* Effect.sync(() =>
            memory.objects.delete("nodes/session-b.json"),
          );
          let posts = 0;
          const client = HttpClient.make((request) =>
            Effect.sync(() => {
              const pointer = memory.graph.root.pointer;
              if (request.method === "POST") {
                posts++;
                return HttpClientResponse.fromWeb(
                  request,
                  mode === "reload-failed"
                    ? Response.json({ error: "Build failed" }, { status: 422 })
                    : Response.json({
                        ok: true,
                        outcome: "adopted",
                        generation: 2,
                        version: pointer.version,
                        prefix: pointer.prefix,
                      }),
                );
              }
              if (mode === "membership-changed")
                memory.put(
                  "nodes/session-c.json",
                  memory.lease("session-c", "10.0.0.3:8081"),
                );
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  deployment: {
                    generation: mode === "drift" ? 3 : 2,
                    version: pointer.version,
                    prefix: pointer.prefix,
                    draining: [],
                    cells: {},
                    swapping: 0,
                  },
                }),
              );
            }),
          );
          const result = yield* Effect.result(
            makeLocalFleetManagement(
              () => Effect.succeed(memory.store),
              client,
            ).activate(connection, memory.graph),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.reason).toBe(mode);
          expect(posts).toBe(1);
        }
      }),
  );

  it.effect(
    "named pointers and manifests are checked, but never mistaken for node adoption",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        const worker = {
          pointer: {
            ...graph.root.pointer,
            script_name: "worker",
            prefix: `deploy/worker/${version}`,
          },
          manifest: { ...graph.root.manifest, script_name: "worker" },
        };
        const complete: ManagementGraph = { ...graph, workers: [worker] };
        yield* Effect.sync(() => {
          memory.put("deploy/worker/current.json", worker.pointer);
          memory.put(`${worker.pointer.prefix}/manifest.json`, worker.manifest);
        });
        const calls: string[] = [];
        const management = makeLocalFleetManagement(
          () => Effect.succeed(memory.store),
          adminClient(calls),
        );
        const result = yield* management.reload(connection, complete);
        expect(result.assurance).toBe("root-identity-only");
        expect(result.proof?.namedAdoption).toBe("not-observed");
        expect(calls).toHaveLength(4);
        yield* Effect.sync(() =>
          memory.objects.delete("deploy/worker/current.json"),
        );
        const missing = yield* Effect.result(
          management.reload(connection, complete),
        );
        if (Result.isFailure(missing))
          expect(missing.failure.reason).toBe("drift");
        expect(Result.isFailure(missing)).toBe(true);
        expect(calls).toHaveLength(4);
      }),
  );

  it.effect(
    "checks exact manifests before reload, including cron-only changes with unchanged versions",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        yield* Effect.sync(() =>
          memory.put(`${graph.root.pointer.prefix}/manifest.json`, {
            ...graph.root.manifest,
            crons: ["* * * * *"],
          }),
        );
        const calls: string[] = [];
        const management = makeLocalFleetManagement(
          () => Effect.succeed(memory.store),
          adminClient(calls),
        );
        const result = yield* Effect.result(
          management.reload(connection, graph),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.reason).toBe("drift");
        expect(calls).toHaveLength(0);
      }),
  );

  it.effect(
    "does not certify a fleet whose membership changes during reload",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        const calls: string[] = [];
        const client = adminClient(calls, (url) => {
          if (url.pathname === "/state")
            memory.put(
              "nodes/session-c.json",
              memory.lease("session-c", "10.0.0.3:8081"),
            );
        });
        const result = yield* Effect.result(
          makeLocalFleetManagement(
            () => Effect.succeed(memory.store),
            client,
          ).reload(connection, graph),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.reason).toBe("membership-changed");
      }),
  );

  it.effect(
    "loads the private peer key and signs the generated D1 bytes for a discovered session",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        let calls = 0;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            expect(request.url).toBe(
              "http://10.0.0.1:8081/runtime/__D1Database:abc",
            );
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag !== "Uint8Array")
              throw new Error("Expected generated JSON bytes");
            const hash = createHash("sha256")
              .update(request.body.body)
              .digest("hex");
            const headers = request.headers;
            const canonical = [
              "cells-peer-request-v1",
              "5",
              "POST",
              "/runtime/__D1Database:abc",
              hash,
              "alchemy-management",
              "session-a",
              headers["x-cells-peer-timestamp"],
              headers["x-cells-peer-nonce"],
            ].join("\n");
            expect(headers["x-cells-peer-signature"]).toBe(
              createHmac("sha256", Buffer.alloc(32, 7))
                .update(canonical)
                .digest("hex"),
            );
            expect(headers["x-cells-peer-target"]).toBe("session-a");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ result: { count: 1, duration: 0 } }),
            );
          }),
        );
        yield* makeLocalFleetManagement(
          () => Effect.succeed(memory.store),
          client,
        ).operator.execD1(connection, {
          scope: "__D1Database:abc",
          exec: { sql: "SELECT 1" },
        });
        expect(calls).toBe(1);
      }),
  );

  it.effect(
    "never replays a failed D1 mutation and does not leak response or secret material",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        let calls = 0;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++;
            return HttpClientResponse.fromWeb(
              request,
              new Response("secret-sql-and-key", { status: 503 }),
            );
          }),
        );
        const result = yield* Effect.result(
          makeLocalFleetManagement(
            () => Effect.succeed(memory.store),
            client,
          ).operator.execD1(connection, {
            scope: "__D1Database:abc",
            exec: { sql: "INSERT INTO secret VALUES (1)" },
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(JSON.stringify(result.failure)).not.toContain("secret");
        expect(calls).toBe(1);
      }),
  );

  it.effect(
    "invalid peer keys fail before sending requests without including the key in errors",
    () =>
      Effect.gen(function* () {
        const memory = yield* fixture;
        yield* Effect.sync(() =>
          memory.put("fleet/peer-auth.json", {
            version: 1,
            key: "do-not-print-me",
          }),
        );
        const calls: string[] = [];
        const result = yield* Effect.result(
          makeLocalFleetManagement(
            () => Effect.succeed(memory.store),
            adminClient(calls),
          ).reload(connection, graph),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(JSON.stringify(result.failure)).not.toContain(
            "do-not-print-me",
          );
        expect(calls).toHaveLength(0);
      }),
  );
});
