import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/gcp/apim_v1alpha";
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

const runLifecycle = hasGcpCreds && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";
const parent = `projects/${project}/locations/${location}`;

const waitUntilGone = (name: string) =>
  apim.getProjectsLocationsObservationJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeAccess = apim
  .listProjectsLocationsObservationJobs({
    parent,
    pageSize: 1,
  })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsObservationJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apim.getProjectsLocationsObservationJobs({
          name: `${parent}/observationJobs/alchemy-missing-job`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("API Management API has not been used");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, enable, and delete an API Observation job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess;
      if (access !== "ok") {
        expect(access).toEqual("Forbidden");
        const listed = yield* Effect.flip(
          apim.listProjectsLocationsObservationJobs({
            parent,
            pageSize: 1,
          }),
        );
        expect(listed._tag).toEqual("Forbidden");
        if (listed._tag === "Forbidden") {
          expect(listed.message).toContain(
            "API Management API has not been used",
          );
        }
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
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
  { timeout: 120_000 },
);
