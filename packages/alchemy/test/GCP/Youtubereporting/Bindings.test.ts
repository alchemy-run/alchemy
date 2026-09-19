import { Action } from "@/Action";
import * as GCP from "@/GCP";
import { DEFAULT_REPORT_TYPE_ID } from "@/GCP/Youtubereporting/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const entitlementTags = ["Forbidden", "NotFound"] as const;

const pickReportTypeId = () =>
  youtubereporting.listReportTypes({ pageSize: 50 }).pipe(
    Effect.map(
      (page) =>
        (page.reportTypes ?? []).find(
          (type) => type.id && type.systemManaged !== true,
        )?.id ?? DEFAULT_REPORT_TYPE_ID,
    ),
    Effect.catchTag(["Forbidden", "NotFound"], () => Effect.succeed(undefined)),
  );

const probeAccess = () =>
  youtubereporting.listJobs({ pageSize: 1, includeSystemManaged: false }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetJob round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect([...entitlementTags]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const reportTypeId = yield* pickReportTypeId();
      if (reportTypeId === undefined) {
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const job = yield* GCP.Youtubereporting.Job("Daily", {
            name: "alchemy-binding-daily",
            reportTypeId,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* job.jobId;
              const getJob = yield* GCP.Youtubereporting.GetJob(job);
              return Effect.fn(function* () {
                return yield* getJob({});
              });
            }),
          );
          return { job, metadata: yield* Probe({}) };
        }),
      );

      expect(out.metadata.id).toEqual(out.job.jobId);
      expect(out.metadata.name).toContain("[alchemy ");
      expect(out.metadata.reportTypeId).toEqual(reportTypeId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
