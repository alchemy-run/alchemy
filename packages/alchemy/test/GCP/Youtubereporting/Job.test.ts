import * as GCP from "@/GCP";
import {
  DEFAULT_REPORT_TYPE_ID,
  PROBE_JOB_ID,
} from "@/GCP/Youtubereporting/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as youtubereporting from "@distilled.cloud/gcp/youtubereporting_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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

const createEntitlementTags = ["Forbidden", "NotFound", "BadRequest"] as const;
const getEntitlementTags = ["Forbidden", "NotFound"] as const;

const waitUntilGone = (jobId: string) =>
  youtubereporting.getJobs({ jobId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

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

test.provider.skipIf(!hasGcpCreds)(
  "getJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        youtubereporting.getJobs({ jobId: PROBE_JOB_ID }),
      );
      expect([...getEntitlementTags]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createJobs without YouTube Reporting access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* youtubereporting
        .createJobs({
          body: {
            name: "alchemy-youtubereporting-probe",
            reportTypeId: DEFAULT_REPORT_TYPE_ID,
          },
        })
        .pipe(
          Effect.map((job) => ({
            _tag: "ok" as const,
            jobId: job.id,
          })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({ _tag: error._tag, jobId: undefined }),
          ),
        );

      if (result._tag === "ok") {
        if (result.jobId) {
          yield* youtubereporting
            .deleteJobs({ jobId: result.jobId })
            .pipe(
              Effect.catchTag(
                ["NotFound", "Forbidden", "BadRequest"],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect([...createEntitlementTags]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, replace, and delete a job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect([...getEntitlementTags]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const reportTypeId = yield* pickReportTypeId();
      if (reportTypeId === undefined) {
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Youtubereporting.Job("Daily", {
            name: "alchemy-daily",
            reportTypeId,
          });
        }),
      );

      expect(created.jobId).toEqual(expect.any(String));
      expect(created.jobId.length).toBeGreaterThan(0);
      expect(created.name).toEqual("alchemy-daily");
      expect(created.reportTypeId).toEqual(reportTypeId);

      const fetched = yield* youtubereporting.getJobs({
        jobId: created.jobId,
      });
      expect(fetched.id).toEqual(created.jobId);
      expect(fetched.name).toContain("alchemy-id=");
      expect(fetched.name).toContain("alchemy-daily");
      expect(fetched.reportTypeId).toEqual(reportTypeId);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Youtubereporting.Job("Daily", {
            name: "alchemy-daily-v2",
            reportTypeId,
          });
        }),
      );

      expect(updated.name).toEqual("alchemy-daily-v2");
      expect(updated.reportTypeId).toEqual(reportTypeId);
      expect(updated.jobId).toEqual(expect.any(String));

      const fetchedUpdate = yield* youtubereporting.getJobs({
        jobId: updated.jobId,
      });
      expect(fetchedUpdate.name).toContain("alchemy-daily-v2");

      if (updated.jobId !== created.jobId) {
        const goneOld = yield* waitUntilGone(created.jobId);
        expect(goneOld).toEqual("gone");
      }

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.jobId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
