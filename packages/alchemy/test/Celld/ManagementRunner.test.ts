import { Credentials } from "@distilled.cloud/aws/Credentials";
import { ApplicationActivation } from "@/Celld/Application.ts";
import { prepareDeployment } from "@/Celld/Deployment.ts";
import { bytes, digest } from "@/Celld/Deployment/Objects.ts";
import { ManagementBindings } from "@/Celld/ManagementBindings.ts";
import {
  FleetManagement,
  makeLocalFleetManagement,
  type FleetManagementService,
} from "@/Celld/Management.ts";
import {
  FleetManagementLambda,
  ManagementRunner,
  handleManagementRequest,
} from "@/Celld/ManagementRunner.ts";
import type { Store } from "@/Celld/FleetStorage.ts";
import * as Clock from "effect/Clock";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import * as Output from "@/Output.ts";
import { inMemoryState } from "@/State/InMemoryState.ts";
import { Providers } from "@/AWS/Providers.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const connection = {
  bucket: { uri: "s3://test-cells" },
  hostState: {
    managementFunctionArn:
      "arn:aws:lambda:us-east-1:123456789012:function:celld-management",
  },
};
const credentials = Layer.succeed(
  Credentials,
  Effect.succeed({
    accessKeyId: Redacted.make("AKIATEST"),
    secretAccessKey: Redacted.make("test-secret"),
    sessionToken: undefined,
    region: "us-east-1" as const,
  }),
);
const input = { scope: "__D1Database:abc", exec: { sql: "SELECT 1" } };
const stub = (calls: string[]): FleetManagementService => ({
  reload: () =>
    Effect.sync(() => {
      calls.push("reload");
      return { assurance: "root-identity-only" as const, nodes: [] };
    }),
  activate: (_connection, graph) =>
    Effect.sync(() => {
      calls.push("activate");
      return {
        assurance: "locked-graph-generation" as const,
        cronDelivery: "not-observed" as const,
        graphRevision: "1".repeat(64),
        publicationRevision: "2".repeat(64),
        proof: {
          assurance: "forced-root-reload" as const,
          namedAdoption: "not-observed" as const,
          root: graph.root.pointer,
          snapshots: [],
          nodes: [],
        },
      };
    }),
  operator: {
    execD1: (_connection, request) =>
      Effect.sync(() => {
        calls.push(request.exec.sql);
        return { result: { count: 1, duration: 0 } };
      }),
    executeD1Statements: () =>
      Effect.sync(() => {
        calls.push("statements");
        return { result: [] };
      }),
    migrateD1: () =>
      Effect.sync(() => {
        calls.push("migrate");
        return { result: { count: 1, duration: 0 } };
      }),
  },
});

describe("Celld IAM management runner", () => {
  it.effect(
    "activation sends only pointers and manifests even with substantial modules and assets",
    () =>
      Effect.gen(function* () {
        const body = yield* bytes("a".repeat(256 * 1024));
        const sha256 = yield* digest(body);
        const prepare = (scriptName: string) =>
          prepareDeployment({
            scriptName,
            mainModule: "main.js",
            modules: [
              {
                name: "main.js",
                content: `export default {}; /*${"x".repeat(256 * 1024)}*/`,
              },
            ],
            metadata: {},
            doClasses: [],
            sqliteClasses: [],
            assets: {
              index: {
                schema_version: 1,
                entries: { "/asset.txt": { sha256, bytes: body.length } },
                config: {},
              },
              blobs: [{ sha256, body }],
            },
          });
        const root = yield* prepare("root");
        const worker = yield* prepare("worker");
        const graph = { root, workers: [worker] };
        const fullSize = yield* Effect.sync(
          () => new TextEncoder().encode(JSON.stringify(graph)).byteLength,
        );
        expect(fullSize).toBeGreaterThan(6 * 1024 * 1024);
        const calls: string[] = [];
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            const event = yield* Effect.sync(() => {
              if (request.body._tag !== "Uint8Array")
                throw new Error("Expected Lambda payload bytes");
              expect(request.body.body.byteLength).toBeLessThan(16 * 1024);
              const event = JSON.parse(
                new TextDecoder().decode(request.body.body),
              );
              expect(event.operation).toBe("activate");
              expect(event.input).toEqual({
                root: { pointer: root.pointer, manifest: root.manifest },
                workers: [
                  { pointer: worker.pointer, manifest: worker.manifest },
                ],
              });
              return event;
            });
            const response = yield* handleManagementRequest(
              event,
              connection,
              stub(calls),
            );
            return yield* Effect.sync(() =>
              HttpClientResponse.fromWeb(request, Response.json(response)),
            );
          }),
        );
        yield* Effect.gen(function* () {
          const activation = yield* ApplicationActivation;
          yield* activation.activate(
            { ...connection, fleetId: "fleet", fleetUrl: "https://fleet.test" },
            root,
            [worker],
            "publication-revision",
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              ManagementBindings,
              FleetManagementLambda.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    credentials,
                    Layer.succeed(HttpClient.HttpClient, client),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(calls).toEqual(["activate"]);
      }),
  );

  it.effect(
    "round-trips IAM proxy to runner dispatch to a signed native D1 request",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const records = yield* Effect.sync(
          () =>
            new Map([
              [
                "nodes/node-session.json",
                {
                  body: new TextEncoder().encode(
                    JSON.stringify({
                      node: "node-session",
                      addr: "10.1.2.3:8081",
                      expires_ms: now + 60_000,
                      peer_protocol: 5,
                    }),
                  ),
                  etag: "node",
                },
              ],
              [
                "fleet/peer-auth.json",
                {
                  body: new TextEncoder().encode(
                    JSON.stringify({ version: 1, key: "09".repeat(32) }),
                  ),
                  etag: "secret",
                },
              ],
            ]),
        );
        const store: Store = {
          get: (key) => Effect.sync(() => records.get(key)),
          list: (prefix) =>
            Effect.sync(() =>
              [...records]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key, etag: value.etag })),
            ),
          put: () => Effect.die("Unexpected mutation"),
          delete: () => Effect.die("Unexpected deletion"),
        };
        let nativeCalls = 0;
        const native = HttpClient.make((request) =>
          Effect.sync(() => {
            nativeCalls++;
            expect(request.url).toBe(
              "http://10.1.2.3:8081/runtime/__D1Database:abc",
            );
            expect(request.headers["x-cells-peer-target"]).toBe("node-session");
            expect(request.headers["x-cells-peer-signature"]).toMatch(
              /^[a-f0-9]{64}$/,
            );
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ result: { count: 1, duration: 0 } }),
            );
          }),
        );
        const local = makeLocalFleetManagement(
          () => Effect.succeed(store),
          native,
        );
        let invocations = 0;
        const iam = HttpClient.make((request) =>
          Effect.gen(function* () {
            const event = yield* Effect.sync(() => {
              invocations++;
              if (request.body._tag !== "Uint8Array")
                throw new Error("Expected Lambda payload");
              return JSON.parse(new TextDecoder().decode(request.body.body));
            });
            const response = yield* handleManagementRequest(
              event,
              connection,
              local,
            );
            return yield* Effect.sync(() =>
              HttpClientResponse.fromWeb(request, Response.json(response)),
            );
          }),
        );
        yield* Effect.gen(function* () {
          const management = yield* FleetManagement;
          expect(
            (yield* management.operator.execD1(connection, input)).result.count,
          ).toBe(1);
        }).pipe(
          Effect.provide(
            FleetManagementLambda.pipe(
              Layer.provide(
                Layer.mergeAll(
                  credentials,
                  Layer.succeed(HttpClient.HttpClient, iam),
                ),
              ),
            ),
          ),
        );
        expect(invocations).toBe(1);
        expect(nativeCalls).toBe(1);
      }),
  );
  it.effect(
    "dispatches only validated requests against the runner-owned bucket",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const management = stub(calls);
        const result = yield* handleManagementRequest(
          {
            version: 1,
            bucket: connection.bucket.uri,
            operation: "execD1",
            input,
          },
          connection,
          management,
        );
        expect(result.ok).toBe(true);
        expect(calls).toEqual(["SELECT 1"]);
        for (const request of [
          { version: 1, bucket: "s3://other", operation: "execD1", input },
          {
            version: 1,
            bucket: connection.bucket.uri,
            operation: "shutdown",
            input,
          },
          {
            version: 1,
            bucket: connection.bucket.uri,
            operation: "execD1",
            input: { scope: "x", exec: "invalid" },
          },
          {
            version: 2,
            bucket: connection.bucket.uri,
            operation: "execD1",
            input,
          },
        ]) {
          expect(
            (yield* handleManagementRequest(request, connection, management))
              .ok,
          ).toBe(false);
        }
        expect(calls).toHaveLength(1);
      }),
  );

  it.effect(
    "IAM proxy performs one synchronous signed Lambda invocation and decodes the SDK output",
    () => {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          expect(request.method).toBe("POST");
          expect(request.headers["x-amz-invocation-type"]).toBe(
            "RequestResponse",
          );
          expect(request.headers["x-amz-log-type"]).toBe("None");
          expect(request.headers.authorization).toContain("AWS4-HMAC-SHA256");
          expect(request.body._tag).toBe("Uint8Array");
          if (request.body._tag !== "Uint8Array")
            throw new Error("Expected Lambda payload bytes");
          const body = JSON.parse(new TextDecoder().decode(request.body.body));
          expect(body.bucket).toBe("s3://test-cells");
          expect(body.operation).toBe("execD1");
          expect(body.input).toEqual(input);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              ok: true,
              value: { result: { count: 1, duration: 0 } },
            }),
          );
        }),
      );
      return Effect.gen(function* () {
        const management = yield* FleetManagement;
        expect(
          (yield* management.operator.execD1(connection, input)).result.count,
        ).toBe(1);
        expect(calls).toBe(1);
      }).pipe(
        Effect.provide(
          FleetManagementLambda.pipe(
            Layer.provide(
              Layer.mergeAll(
                credentials,
                Layer.succeed(HttpClient.HttpClient, client),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "IAM response preserves forced-root proof and distinct observation failures",
    () => {
      const pointer = {
        script_name: "root",
        version: "0123456789abcdef",
        prefix: "deploy/root/0123456789abcdef",
        rollout: { percent: 100 },
      };
      const graph = {
        root: {
          pointer,
          manifest: {
            version: pointer.version,
            script_name: "root",
            do_classes: [],
            sqlite_classes: [],
            modules: [],
            raw_metadata: {},
          },
        },
        workers: [],
      };
      const nodes = [
        {
          session: "session-a",
          generation: 2,
          version: pointer.version,
          prefix: pointer.prefix,
        },
      ];
      const proof = {
        assurance: "forced-root-reload",
        namedAdoption: "not-observed",
        root: pointer,
        snapshots: [
          { key: "deploy/current.json", etag: "etag", sha256: "0".repeat(64) },
        ],
        nodes: [
          {
            ...nodes[0],
            endpoint: "http://10.0.0.1:8081",
            outcome: "adopted",
            stateReads: 3,
          },
        ],
      };
      let response: unknown = {
        ok: true,
        value: { assurance: "root-identity-only", nodes, proof },
      };
      const client = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(request, Response.json(response)),
        ),
      );
      return Effect.gen(function* () {
        const management = yield* FleetManagement;
        expect((yield* management.reload(connection, graph)).proof).toEqual(
          proof,
        );
        const calls: string[] = [];
        const activated = yield* handleManagementRequest(
          {
            version: 1,
            bucket: connection.bucket.uri,
            operation: "activate",
            input: graph,
          },
          connection,
          stub(calls),
        );
        expect(activated.ok).toBe(true);
        expect(calls).toEqual(["activate"]);
        yield* Effect.sync(() => {
          response = activated;
        });
        const evidence = yield* management.activate(connection, graph);
        expect(evidence.assurance).toBe("locked-graph-generation");
        expect(evidence.cronDelivery).toBe("not-observed");
        expect(evidence.proof.root).toEqual(pointer);
        yield* Effect.sync(() => {
          response = {
            ok: true,
            value: { assurance: "root-identity-only", nodes, proof },
          };
        });
        expect(
          Result.isFailure(
            yield* Effect.result(management.activate(connection, graph)),
          ),
        ).toBe(true);
        yield* Effect.sync(() => {
          response = {
            ok: true,
            value: { ...evidence, cronDelivery: "observed" },
          };
        });
        expect(
          Result.isFailure(
            yield* Effect.result(management.activate(connection, graph)),
          ),
        ).toBe(true);
        for (const reason of [
          "reload-failed",
          "state-unavailable",
          "swap-pending",
        ] as const) {
          yield* Effect.sync(() => {
            response = {
              ok: false,
              error: { reason, message: "Observation failure" },
            };
          });
          const result = yield* Effect.result(
            management.reload(connection, graph),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure.reason).toBe(reason);
        }
      }).pipe(
        Effect.provide(
          FleetManagementLambda.pipe(
            Layer.provide(
              Layer.mergeAll(
                credentials,
                Layer.succeed(HttpClient.HttpClient, client),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "Lambda invocation errors are not retried and response details are redacted",
    () => {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { Type: "Service", message: "secret request content" },
              {
                status: 500,
                headers: { "x-amzn-errortype": "ServiceException" },
              },
            ),
          );
        }),
      );
      return Effect.gen(function* () {
        const management = yield* FleetManagement;
        const result = yield* Effect.result(
          management.operator.execD1(connection, input),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(JSON.stringify(result.failure)).not.toContain(
            "secret request content",
          );
        expect(calls).toBe(1);
      }).pipe(
        Effect.provide(
          FleetManagementLambda.pipe(
            Layer.provide(
              Layer.mergeAll(
                credentials,
                Layer.succeed(HttpClient.HttpClient, client),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "rejects public management URLs instead of treating them as invocation targets",
    () => {
      let calls = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;
          return HttpClientResponse.fromWeb(request, Response.json({}));
        }),
      );
      return Effect.gen(function* () {
        const management = yield* FleetManagement;
        const result = yield* Effect.result(
          management.operator.execD1(
            {
              ...connection,
              hostState: { managementFunctionArn: "https://public.example" },
            },
            input,
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(calls).toBe(0);
      }).pipe(
        Effect.provide(
          FleetManagementLambda.pipe(
            Layer.provide(
              Layer.mergeAll(
                credentials,
                Layer.succeed(HttpClient.HttpClient, client),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect(
    "factory declares a VPC Lambda without a Function URL and grants only management reads",
    () =>
      Effect.gen(function* () {
        const stack = yield* Stack;
        const vpc = {
          subnetIds: ["subnet-private"],
          securityGroupIds: ["sg-management"],
        };
        const runner = yield* ManagementRunner("Management", {
          bucketName: "test-cells",
          vpc,
          minimumNodes: 2,
        });
        expect(runner.Props.functionUrl).toBe(false);
        expect(runner.Props.vpc).toEqual(vpc);
        expect(runner.Props.env?.CELLD_MANAGEMENT_BUCKET).toBe("test-cells");
        expect(runner.Props.env?.CELLD_MANAGEMENT_MINIMUM_NODES).toBe("2");
        const statements = stack.bindings.Management?.flatMap(
          (binding) => binding.data.policyStatements ?? [],
        );
        expect(statements?.map((statement) => statement.Action)).toEqual([
          ["s3:GetObject"],
          ["s3:ListBucket"],
        ]);
        expect(yield* Output.evaluate(statements?.[0]?.Resource, {})).toEqual([
          "arn:aws:s3:::test-cells/nodes/*",
          "arn:aws:s3:::test-cells/fleet/peer-auth.json",
          "arn:aws:s3:::test-cells/deploy/*",
          "arn:aws:s3:::test-cells/alchemy/application/v1/publisher.json",
          "arn:aws:s3:::test-cells/alchemy/application/v1/current.json",
          "arn:aws:s3:::test-cells/alchemy/deployments/v1/candidates/*",
        ]);
        expect(statements?.[1]?.Condition).toEqual({
          StringLike: { "s3:prefix": ["nodes/"] },
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            inMemoryState(),
            Layer.succeed(Stack, {
              name: "management-test",
              stage: "test",
              resources: {},
              bindings: {},
              actions: {},
            }),
            Layer.succeed(Stage, "test"),
            Layer.succeed(Providers, {
              kind: "ProviderCollection",
              get: () => undefined,
              providers: {},
            }),
          ),
        ),
        Effect.scoped,
      ),
  );
});
