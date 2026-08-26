import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bidmanager from "@distilled.cloud/gcp/doubleclickbidmanager_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { PROBE_QUERY_ID } from "@/GCP/Doubleclickbidmanager/internal.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const waitUntilGone = (queryId: string) =>
  bidmanager.getQueries({ queryId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeBody: bidmanager.Query = {
  metadata: {
    title: "alchemy-bidmanager-probe",
    dataRange: { range: "LAST_7_DAYS" },
    format: "CSV",
  },
  params: {
    type: "STANDARD",
    groupBys: ["FILTER_DATE"],
    metrics: ["METRIC_IMPRESSIONS"],
  },
  schedule: { frequency: "ONE_TIME" },
};

const probeAccess = () =>
  bidmanager.createQueries({ body: probeBody }).pipe(
    Effect.flatMap((query) =>
      query.queryId
        ? bidmanager
            .deleteQueries({ queryId: query.queryId })
            .pipe(
              Effect.catchTag(
                ["NotFound", "Forbidden", "BadRequest"],
                () => Effect.void,
              ),
            )
        : Effect.void,
    ),
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getQueries on a missing query fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        bidmanager.getQueries({ queryId: PROBE_QUERY_ID }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createQueries without Bid Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* bidmanager.createQueries({ body: probeBody }).pipe(
        Effect.map((query) => ({
          _tag: "ok" as const,
          queryId: query.queryId,
        })),
        Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
          Effect.succeed({ _tag: error._tag, queryId: undefined }),
        ),
      );

      if (result._tag === "ok") {
        if (result.queryId) {
          yield* bidmanager
            .deleteQueries({ queryId: result.queryId })
            .pipe(
              Effect.catchTag(
                ["NotFound", "Forbidden", "BadRequest"],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, replace, and delete a query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Doubleclickbidmanager.Query("Weekly", {
            title: "alchemy-weekly",
            type: "STANDARD",
            dataRange: { range: "LAST_7_DAYS" },
            groupBys: ["FILTER_DATE"],
            metrics: ["METRIC_IMPRESSIONS"],
            format: "CSV",
            schedule: { frequency: "ONE_TIME" },
          });
        }),
      );

      expect(created.queryId).toEqual(expect.any(String));
      expect(created.queryId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("alchemy-weekly");
      expect(created.type).toEqual("STANDARD");
      expect(created.dataRange?.range).toEqual("LAST_7_DAYS");
      expect(created.metrics).toContain("METRIC_IMPRESSIONS");

      const fetched = yield* bidmanager.getQueries({
        queryId: created.queryId,
      });
      expect(fetched.queryId).toEqual(created.queryId);
      expect(fetched.metadata?.title).toContain("alchemy-id=");
      expect(fetched.metadata?.title).toContain("alchemy-weekly");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Doubleclickbidmanager.Query("Weekly", {
            title: "alchemy-weekly-v2",
            type: "STANDARD",
            dataRange: { range: "LAST_30_DAYS" },
            groupBys: ["FILTER_DATE"],
            metrics: ["METRIC_IMPRESSIONS"],
            format: "CSV",
            schedule: { frequency: "ONE_TIME" },
          });
        }),
      );

      expect(updated.title).toEqual("alchemy-weekly-v2");
      expect(updated.dataRange?.range).toEqual("LAST_30_DAYS");
      expect(updated.queryId).toEqual(expect.any(String));

      const fetchedUpdate = yield* bidmanager.getQueries({
        queryId: updated.queryId,
      });
      expect(fetchedUpdate.metadata?.dataRange?.range).toEqual("LAST_30_DAYS");
      expect(fetchedUpdate.metadata?.title).toContain("alchemy-weekly-v2");

      if (updated.queryId !== created.queryId) {
        const goneOld = yield* waitUntilGone(created.queryId);
        expect(goneOld).toEqual("gone");
      }

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.queryId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
