import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
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

// Developer Connect is entitlement-gated. Live create returns Forbidden:
// "Developer Connect API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled."
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_DEVELOPERCONNECT === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  developerconnect.getProjectsLocationsInsightsConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(
  !hasGcpCreds || process.env.GCP_TEST_DEVELOPERCONNECT === "1",
)(
  "createProjectsLocationsInsightsConfigs is Forbidden when Developer Connect is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.createProjectsLocationsInsightsConfigs({
          parent: `projects/${project}/locations/${location}`,
          insightsConfigId: "alchemy-insights-probe",
          body: {},
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain(
        "Developer Connect API has not been used",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsInsightsConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsInsightsConfigs({
          name: `projects/${project}/locations/us-central1/insightsConfigs/alchemy-missing-insights`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete an insights config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.InsightsConfig("Sdlc", {
            location: "us-central1",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.insightsConfigId).toEqual(expect.any(String));
      expect(created.name).toContain("/insightsConfigs/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* developerconnect.getProjectsLocationsInsightsConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.InsightsConfig("Sdlc", {
            insightsConfigId: created.insightsConfigId,
            location: "us-central1",
            projects: { projectIds: [project] },
            labels: { env: "prod", role: "sdlc" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "sdlc" });

      const fetchedUpdate =
        yield* developerconnect.getProjectsLocationsInsightsConfigs({
          name: updated.name,
        });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("sdlc");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.InsightsConfig("Sdlc", {
            insightsConfigId: created.insightsConfigId,
            location: "us-east1",
            labels: { env: "test" },
          });
        }),
      );

      expect(replaced.insightsConfigId).toEqual(created.insightsConfigId);
      expect(replaced.location).toEqual("us-east1");
      expect(replaced.name).toContain("/locations/us-east1/");
      expect(replaced.name).not.toEqual(created.name);

      const oldGone = yield* waitUntilGone(created.name);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
