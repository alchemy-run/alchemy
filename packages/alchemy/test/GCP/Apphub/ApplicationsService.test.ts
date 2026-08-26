import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apphub from "@distilled.cloud/gcp/apphub_v1";
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

// App Hub is entitlement-gated. Live create/read returns Forbidden:
// "App Hub API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled." Service registration also needs a
// discovered service in the host project.
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_APPHUB === "1";
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apphub.getProjectsLocationsApplicationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const firstDiscoveredService = apphub
  .listProjectsLocationsDiscoveredServices({
    parent: `projects/${project}/locations/${location}`,
    pageSize: 10,
  })
  .pipe(
    Effect.map((page) => page.discoveredServices?.[0]?.name),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(undefined)),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApplicationsServices on a missing service fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apphub.getProjectsLocationsApplicationsServices({
          name: `projects/${project}/locations/${location}/applications/alchemy-missing-app/services/alchemy-missing-service`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an App Hub service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const discoveredService = yield* firstDiscoveredService;
      expect(discoveredService).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.Apphub.Application("Catalog", {
            location,
            displayName: "catalog",
            scope: { type: "REGIONAL" },
          });
          const service = yield* GCP.Apphub.ApplicationsService("Frontend", {
            application: app.name,
            location,
            discoveredService: discoveredService!,
            displayName: "frontend",
            description: "https frontend",
            attributes: { criticality: { type: "MEDIUM" } },
          });
          return { app, service };
        }),
      );

      expect(created.service.name).toContain("/services/");
      expect(created.service.application).toEqual(created.app.name);
      expect(created.service.displayName).toEqual("frontend");
      expect(created.service.description).toEqual("https frontend");
      expect(created.service.discoveredService).toBeDefined();

      const fetched = yield* apphub.getProjectsLocationsApplicationsServices({
        name: created.service.name,
      });
      expect(fetched.name).toEqual(created.service.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("https frontend");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* GCP.Apphub.Application("Catalog", {
            applicationId: created.app.applicationId,
            location,
            displayName: "catalog",
            scope: { type: "REGIONAL" },
          });
          const service = yield* GCP.Apphub.ApplicationsService("Frontend", {
            serviceId: created.service.serviceId,
            application: app.name,
            location,
            discoveredService: created.service.discoveredService!,
            displayName: "frontend-v2",
            description: "https frontend v2",
            attributes: { criticality: { type: "HIGH" } },
          });
          return { app, service };
        }),
      );

      expect(updated.service.name).toEqual(created.service.name);
      expect(updated.service.displayName).toEqual("frontend-v2");
      expect(updated.service.description).toEqual("https frontend v2");
      expect(updated.service.attributes?.criticality?.type).toEqual("HIGH");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.service.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
