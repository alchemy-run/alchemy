import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as rds from "@distilled.cloud/aws/rds";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import RDSDataTestFunctionLive, { RDSDataTestFunction } from "./handler";

// Aurora Serverless v2 cluster + writer-instance provisioning takes 5-15
// minutes — far beyond the speed doctrine's budget — so the ENTIRE live suite
// (deploy hook, every test, destroy hook) is opt-in behind AWS_TEST_SLOW=1.
// A run without the env var is skip-clean: no AWS calls, no side effects.
const SLOW = !!process.env.AWS_TEST_SLOW;

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RDSDataBindings");

let baseUrl: string;
let clusterIdentifier: string | undefined;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class ClusterStillPresent extends Data.TaggedError("ClusterStillPresent")<{
  readonly clusterIdentifier: string;
}> {}

// The fixture surfaces every failure as a 500 (handler-level `Effect.orDie`).
// A 5xx from this Lambda is either a cold re-init or an rds-data transient
// (DatabaseResumingException / DatabaseUnavailableException while the
// serverless cluster scales from idle) — retry those on a generous bounded
// schedule; a 4xx/assertion failure is surfaced immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.spaced("5 seconds").pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

const postJson = (url: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body),
  ).pipe(Effect.flatMap((r) => r.json));

describe("RDSData Bindings", () => {
  beforeAll(
    SLOW
      ? Effect.gen(function* () {
          yield* Effect.logInfo(
            "RDSData test setup: destroying previous resources",
          );
          yield* sharedStack.destroy();

          yield* Effect.logInfo(
            "RDSData test setup: deploying Aurora SV2 + Lambda fixture (5-15 min)",
          );
          const { functionUrl } = yield* sharedStack.deploy(
            Effect.gen(function* () {
              return yield* RDSDataTestFunction;
            }).pipe(Effect.provide(RDSDataTestFunctionLive)),
          );

          expect(functionUrl).toBeTruthy();
          baseUrl = functionUrl!.replace(/\/+$/, "");

          // Bounded readiness poll (gated-suite only): the cluster is already
          // `available` when deploy returns (the DBCluster/DBInstance
          // reconcilers wait for it), so this covers Lambda URL cold start
          // plus first Data API connection setup. Generous spaced schedule:
          // 10s x 42 ≈ 7 min ceiling.
          yield* HttpClient.get(`${baseUrl}/health`).pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? Effect.succeed(response)
                : Effect.fail(
                    new Error(`Fixture not ready: ${response.status}`),
                  ),
            ),
            Effect.tapError((error) =>
              Effect.logWarning(
                `RDSData test setup: fixture not ready yet (${String(error)})`,
              ),
            ),
            Effect.retry({
              schedule: Schedule.spaced("10 seconds").pipe(
                Schedule.both(Schedule.recurs(42)),
              ),
            }),
          );

          // Capture the cluster identifier so afterAll can verify deletion
          // out-of-band after destroy.
          const meta = (yield* HttpClient.get(`${baseUrl}/meta`).pipe(
            Effect.flatMap((r) => r.json),
          )) as { clusterIdentifier: string };
          clusterIdentifier = meta.clusterIdentifier;
          yield* Effect.logInfo(
            `RDSData test setup: fixture ready (cluster ${clusterIdentifier})`,
          );

          // Create the shared table once for all binding tests.
          yield* postJson(`${baseUrl}/setup`, {});
        })
      : Effect.void,
    { timeout: 1_500_000 },
  );

  afterAll(
    SLOW
      ? Effect.gen(function* () {
          yield* sharedStack.destroy();

          // Out-of-band deletion check via distilled: the DBCluster provider
          // already waits until the cluster is gone, so this is a bounded
          // confirmation, not a long poll.
          if (clusterIdentifier) {
            yield* Core.withProviders(
              rds
                .describeDBClusters({ DBClusterIdentifier: clusterIdentifier })
                .pipe(
                  Effect.flatMap((response) =>
                    (response.DBClusters ?? []).length === 0
                      ? Effect.void
                      : Effect.fail(
                          new ClusterStillPresent({
                            clusterIdentifier: clusterIdentifier!,
                          }),
                        ),
                  ),
                  Effect.catchTag("DBClusterNotFoundFault", () => Effect.void),
                  Effect.retry({
                    schedule: Schedule.spaced("15 seconds").pipe(
                      Schedule.both(Schedule.recurs(8)),
                    ),
                  }),
                ),
              testOptions,
              sharedStack.name,
            );
          }
        })
      : Effect.void,
    { timeout: 1_500_000 },
  );

  describe("ExecuteStatement", () => {
    test.provider.skipIf(!SLOW)(
      "inserts and selects a row with typed parameters",
      (_stack) =>
        Effect.gen(function* () {
          const insert = (yield* postJson(`${baseUrl}/insert`, {
            id: 1,
            title: "first",
          })) as { success: boolean; numberOfRecordsUpdated: number };
          expect(insert.success).toBe(true);
          expect(insert.numberOfRecordsUpdated).toBe(1);

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=1`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            records: { longValue?: number; stringValue?: string }[][];
          };
          expect(select.records).toHaveLength(1);
          expect(select.records[0]![0]!.longValue).toBe(1);
          expect(select.records[0]![1]!.stringValue).toBe("first");
        }),
      { timeout: 120_000 },
    );

    test.provider.skipIf(!SLOW)(
      "returns no records for a missing row",
      (_stack) =>
        Effect.gen(function* () {
          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=999999`),
          ).pipe(Effect.flatMap((r) => r.json))) as { records: unknown[] };
          expect(select.records).toHaveLength(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("BatchExecuteStatement", () => {
    test.provider.skipIf(!SLOW)(
      "inserts multiple rows via parameterSets",
      (_stack) =>
        Effect.gen(function* () {
          const batch = (yield* postJson(`${baseUrl}/batch-insert`, {
            rows: [
              { id: 10, title: "batch-a" },
              { id: 11, title: "batch-b" },
            ],
          })) as { updateResults: unknown[] };
          expect(batch.updateResults).toHaveLength(2);

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=11`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            records: { longValue?: number; stringValue?: string }[][];
          };
          expect(select.records[0]![1]!.stringValue).toBe("batch-b");
        }),
      { timeout: 120_000 },
    );
  });

  describe("BeginTransaction", () => {
    test.provider.skipIf(!SLOW)(
      "returns a transaction id",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson(`${baseUrl}/tx-commit`, {
            id: 20,
            title: "begin",
          })) as { transactionId: string };
          expect(result.transactionId).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });

  describe("CommitTransaction", () => {
    test.provider.skipIf(!SLOW)(
      "commits an insert so it is visible afterwards",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson(`${baseUrl}/tx-commit`, {
            id: 30,
            title: "committed",
          })) as { transactionId: string; transactionStatus: string };
          expect(result.transactionId).toBeTruthy();

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=30`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            records: { longValue?: number; stringValue?: string }[][];
          };
          expect(select.records).toHaveLength(1);
          expect(select.records[0]![1]!.stringValue).toBe("committed");
        }),
      { timeout: 120_000 },
    );
  });

  describe("RollbackTransaction", () => {
    test.provider.skipIf(!SLOW)(
      "rolls back an insert so it never becomes visible",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson(`${baseUrl}/tx-rollback`, {
            id: 40,
            title: "rolled-back",
          })) as { transactionId: string; transactionStatus: string };
          expect(result.transactionId).toBeTruthy();

          const select = (yield* send(
            HttpClientRequest.get(`${baseUrl}/select?id=40`),
          ).pipe(Effect.flatMap((r) => r.json))) as { records: unknown[] };
          expect(select.records).toHaveLength(0);
        }),
      { timeout: 120_000 },
    );
  });

  // `ExecuteSql` is deprecated (Aurora Serverless v1 era API) — implemented
  // for completeness but intentionally not exercised against live AWS.
});
