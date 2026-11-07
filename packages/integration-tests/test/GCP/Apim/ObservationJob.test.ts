import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// The testing project doesn't enable apim.googleapis.com by default: every test
// deploys it first.
// Observation sources sit on an Apigee organization: create answers BadRequest
// "Apigee organization is not provisioned for project", and jobs need a
// source. Set GCP_TEST_APIGEE_ORG=1 on a project with one.
const apigeeOrg = !!process.env.GCP_TEST_APIGEE_ORG && !process.env.FAST;

const ApimApi = GCP.ServiceUsage.ProjectService("ApimApi", {
  service: "apim.googleapis.com",
});
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apim.getProjectsLocationsObservationJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsObservationJobs on a missing job fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;

      yield* stack.destroy();
      yield* stack.deploy(ApimApi);

      const error = yield* Effect.flip(
        apim.getProjectsLocationsObservationJobs({
          name: `${parent}/observationJobs/alchemy-missing-job`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apim", "live"], timeout: 90_000 },
);

test.provider.skipIf(!apigeeOrg)(
  "create, enable, and delete an API Observation job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/${location}`;

      yield* stack.destroy();
      yield* stack.deploy(ApimApi);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* ApimApi;
          return yield* GCP.Apim.ObservationJob("Shadow", {
            location,
            enabled: false,
          });
        }),
      );

      expect(created.name).toContain("/observationJobs/");
      expect(created.observationJobId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.enabled).toEqual(false);

      const fetched = yield* apim.getProjectsLocationsObservationJobs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* ApimApi;
          return yield* GCP.Apim.ObservationJob("Shadow", {
            observationJobId: created.observationJobId,
            location,
            enabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.enabled).toEqual(true);

      const refetched = yield* apim.getProjectsLocationsObservationJobs({
        name: created.name,
      });
      expect((refetched.state ?? "").toUpperCase()).toEqual("ENABLED");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apim", "live"], timeout: 120_000 },
);
