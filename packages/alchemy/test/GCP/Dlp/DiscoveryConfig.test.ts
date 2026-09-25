import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
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

const pausedTarget = () => ({
  cloudStorageTarget: {
    filter: { others: {} },
    disabled: {},
  },
});

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsDiscoveryConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsDiscoveryConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsDiscoveryConfigs({
          name: `projects/${project}/locations/us/discoveryConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a paused discovery config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* dlp
        .listProjectsLocationsDiscoveryConfigs({
          parent: `projects/${project}/locations/us`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Dlp.LocationsInspectTemplate(
            "EmailInspect",
            {
              location: "us",
              displayName: "emails",
              inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            },
          );
          return yield* GCP.Dlp.DiscoveryConfig("Profiles", {
            location: "us",
            displayName: "paused storage",
            status: "PAUSED",
            inspectTemplates: [template.name],
            targets: [pausedTarget()],
          });
        }),
      );

      expect(created.configId).toEqual(expect.any(String));
      expect(created.location).toEqual("us");
      expect(created.name).toContain("/discoveryConfigs/");
      expect(created.displayName).toEqual("paused storage");
      expect(created.status).toEqual("PAUSED");

      const fetched = yield* dlp.getProjectsLocationsDiscoveryConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const template = yield* GCP.Dlp.LocationsInspectTemplate(
            "EmailInspect",
            {
              location: "us",
              displayName: "emails",
              inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            },
          );
          return yield* GCP.Dlp.DiscoveryConfig("Profiles", {
            configId: created.configId,
            location: "us",
            displayName: "paused storage v2",
            status: "PAUSED",
            inspectTemplates: [template.name],
            targets: [pausedTarget()],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("paused storage v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
