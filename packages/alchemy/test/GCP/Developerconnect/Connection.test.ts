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

const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_DEVELOPERCONNECT === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  developerconnect.getProjectsLocationsConnections({ name }).pipe(
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
  "createProjectsLocationsConnections is Forbidden when Developer Connect is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.createProjectsLocationsConnections({
          parent: `projects/${project}/locations/${location}`,
          connectionId: "alchemy-connection-probe",
          body: {
            githubConfig: { githubApp: "DEVELOPER_CONNECT" },
          },
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
  "getProjectsLocationsConnections on a missing connection fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsConnections({
          name: `projects/${project}/locations/${location}/connections/alchemy-missing-connection`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a developer connect connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.Connection("Github", {
            location,
            githubConfig: { githubApp: "DEVELOPER_CONNECT" },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/connections/");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* developerconnect.getProjectsLocationsConnections({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.Connection("Github", {
            connectionId: created.connectionId,
            location,
            githubConfig: { githubApp: "DEVELOPER_CONNECT" },
            labels: { env: "prod", role: "git" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "git" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
