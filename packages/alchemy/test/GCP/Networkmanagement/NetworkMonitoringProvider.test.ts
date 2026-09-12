import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";
// Network Monitoring Provider create is entitlement-gated on the default
// testing project (`Forbidden`: "Network Management API has not been used
// in project alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_NETWORKMANAGEMENT=1 on an entitled project to run the full
// lifecycle.
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_NETWORKMANAGEMENT === "1";

const waitUntilGone = (name: string) =>
  networkmanagement
    .getProjectsLocationsNetworkMonitoringProviders({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsNetworkMonitoringProviders on a missing provider fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkmanagement.getProjectsLocationsNetworkMonitoringProviders({
          name: `projects/${project}/locations/us-central1/networkMonitoringProviders/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with Forbidden when the Network Management API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        networkmanagement.createProjectsLocationsNetworkMonitoringProviders({
          parent: `projects/${project}/locations/us-central1`,
          networkMonitoringProviderId: "alchemy-nmp-probe",
          body: { providerType: "EXTERNAL" },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a network monitoring provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Networkmanagement.NetworkMonitoringProvider(
            "AppNeta",
            { providerType: "EXTERNAL" },
          );
        }),
      );

      expect(created.name).toContain("/networkMonitoringProviders/");
      expect(created.networkMonitoringProviderId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.providerType).toEqual("EXTERNAL");
      expect(created.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkmanagement.getProjectsLocationsNetworkMonitoringProviders(
          { name: created.name },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.providerType).toEqual("EXTERNAL");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
