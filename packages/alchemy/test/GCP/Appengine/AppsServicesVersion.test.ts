import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as appengine from "@distilled.cloud/gcp/appengine_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_APPENGINE;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const sourceUrl = process.env.GCP_TEST_APPENGINE_SOURCE_URL ?? "";

const waitUntilGone = (
  appsId: string,
  servicesId: string,
  versionsId: string,
) =>
  appengine
    .getAppsServicesVersions({
      appsId,
      servicesId,
      versionsId,
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getAppsServicesVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getAppsServicesVersions({
          appsId: project,
          servicesId: "default",
          versionsId: "alchemy-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_APPENGINE)(
  "createAppsServicesVersions without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createAppsServicesVersions({
          appsId: project,
          servicesId: "default",
          body: {
            id: "alchemy-probe",
            runtime: "python311",
          },
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle || sourceUrl.length === 0)(
  "create, update, and delete a service version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.AppsServicesVersion("Api", {
            runtime: "python311",
            servingStatus: "SERVING",
            automaticScaling: {
              standardSchedulerSettings: {
                minInstances: 0,
                maxInstances: 1,
              },
            },
            deployment: {
              zip: { sourceUrl },
            },
          });
        }),
      );

      expect(created.versionId.length).toBeGreaterThan(0);
      expect(created.runtime).toEqual("python311");
      expect(created.serviceId).toEqual("default");

      const fetched = yield* appengine.getAppsServicesVersions({
        appsId: created.appsId,
        servicesId: created.serviceId,
        versionsId: created.versionId,
        view: "FULL",
      });
      expect(fetched.id).toEqual(created.versionId);
      expect(fetched.envVariables?.ALCHEMY_OWNERSHIP).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.AppsServicesVersion("Api", {
            versionId: created.versionId,
            runtime: "python311",
            servingStatus: "STOPPED",
            deployment: {
              zip: { sourceUrl },
            },
          });
        }),
      );

      expect(updated.versionId).toEqual(created.versionId);
      expect(updated.servingStatus).toEqual("STOPPED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.appsId,
        created.serviceId,
        created.versionId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
