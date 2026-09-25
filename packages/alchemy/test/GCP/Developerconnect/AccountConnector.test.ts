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
// before or it is disabled. Enable it by visiting
// https://console.developers.google.com/apis/api/developerconnect.googleapis.com/overview?project=alchemy-gcp-testing-83661"
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_DEVELOPERCONNECT === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  developerconnect.getProjectsLocationsAccountConnectors({ name }).pipe(
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
  "createProjectsLocationsAccountConnectors is Forbidden when Developer Connect is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.createProjectsLocationsAccountConnectors({
          parent: `projects/${project}/locations/${location}`,
          accountConnectorId: "alchemy-developerconnect-probe",
          body: {
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
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
  "getProjectsLocationsAccountConnectors on a missing connector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsAccountConnectors({
          name: `projects/${project}/locations/us-central1/accountConnectors/alchemy-missing-connector`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete an account connector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.AccountConnector("Github", {
            location: "us-central1",
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.accountConnectorId).toEqual(expect.any(String));
      expect(created.name).toContain("/accountConnectors/");
      expect(created.location).toEqual("us-central1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.providerOauthConfig?.systemProviderId).toEqual("GITHUB");

      const fetched =
        yield* developerconnect.getProjectsLocationsAccountConnectors({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.providerOauthConfig?.systemProviderId).toEqual("GITHUB");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.AccountConnector("Github", {
            accountConnectorId: created.accountConnectorId,
            location: "us-central1",
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
            labels: { env: "prod", role: "scm" },
            proxyConfig: { enabled: true },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "scm" });
      expect(updated.proxyConfig?.enabled).toEqual(true);

      const fetchedUpdate =
        yield* developerconnect.getProjectsLocationsAccountConnectors({
          name: updated.name,
        });
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("scm");
      expect(fetchedUpdate.proxyConfig?.enabled).toEqual(true);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Developerconnect.AccountConnector("Github", {
            accountConnectorId: created.accountConnectorId,
            location: "us-east1",
            providerOauthConfig: {
              systemProviderId: "GITHUB",
              scopes: ["repo"],
            },
            labels: { env: "test" },
          });
        }),
      );

      expect(replaced.accountConnectorId).toEqual(created.accountConnectorId);
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
