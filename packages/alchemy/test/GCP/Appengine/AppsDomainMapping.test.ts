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
const domain =
  process.env.GCP_TEST_APPENGINE_DOMAIN ?? "alchemy-appengine.test";

const waitUntilGone = (appsId: string, domainId: string) =>
  appengine
    .getAppsDomainMappings({
      appsId,
      domainMappingsId: domainId,
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
  "getAppsDomainMappings on a missing mapping fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getAppsDomainMappings({
          appsId: project,
          domainMappingsId: "alchemy-missing.example.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_APPENGINE)(
  "createAppsDomainMappings without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createAppsDomainMappings({
          appsId: project,
          body: {
            id: "alchemy-missing.example.com",
            sslSettings: { sslManagementType: "AUTOMATIC" },
          },
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a domain mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.AppsDomainMapping("Www", {
            domain,
            sslSettings: { sslManagementType: "AUTOMATIC" },
          });
        }),
      );

      expect(created.domain).toEqual(domain);
      expect(created.appsId).toEqual(project);

      const fetched = yield* appengine.getAppsDomainMappings({
        appsId: created.appsId,
        domainMappingsId: created.domain,
      });
      expect(fetched.id).toEqual(created.domain);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.AppsDomainMapping("Www", {
            domain: created.domain,
            sslSettings: { sslManagementType: "MANUAL" },
          });
        }),
      );

      expect(updated.domain).toEqual(created.domain);
      expect(updated.sslManagementType).toEqual("MANUAL");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appsId, created.domain);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
