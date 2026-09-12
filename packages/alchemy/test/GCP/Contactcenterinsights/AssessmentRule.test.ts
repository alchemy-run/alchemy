import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cci from "@distilled.cloud/gcp/contactcenterinsights_v1";
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

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_CONTACTCENTERINSIGHTS;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  cci.getProjectsLocationsAssessmentRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAssessmentRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cci.getProjectsLocationsAssessmentRules({
          name: `projects/${project}/locations/us-central1/assessmentRules/alchemy-missing-rule`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an assessment rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenterinsights.AssessmentRule("Qa", {
            displayName: "hourly-qa",
            active: false,
            sampleRule: { samplePercentage: 10 },
            scheduleInfo: { schedule: "every 1 hours", timeZone: "UTC" },
          });
        }),
      );

      expect(created.assessmentRuleId).toEqual(expect.any(String));
      expect(created.name).toContain("/assessmentRules/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("hourly-qa");
      expect(created.active).toEqual(false);
      expect(created.sampleRule?.samplePercentage).toEqual(10);

      const fetched = yield* cci.getProjectsLocationsAssessmentRules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.active).toEqual(false);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contactcenterinsights.AssessmentRule("Qa", {
            assessmentRuleId: created.assessmentRuleId,
            location: "us-central1",
            displayName: "hourly-qa-v2",
            active: false,
            sampleRule: { samplePercentage: 20 },
            scheduleInfo: { schedule: "every 2 hours", timeZone: "UTC" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("hourly-qa-v2");
      expect(updated.sampleRule?.samplePercentage).toEqual(20);
      expect(updated.scheduleInfo?.schedule).toEqual("every 2 hours");

      const fetchedUpdate = yield* cci.getProjectsLocationsAssessmentRules({
        name: updated.name,
      });
      expect(fetchedUpdate.sampleRule?.samplePercentage).toEqual(20);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
