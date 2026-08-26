import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsPluginsInstances({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsPluginsInstances on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsPluginsInstances({
          name: `projects/${project}/locations/${location}/plugins/alchemy-missing-plugin/instances/alchemy-missing-instance`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub plugin instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.Apihub.Plugin("OnRamp", {
            location,
            displayName: "on-ramp",
            description: "plugin for instance test",
          });
          const instance = yield* GCP.Apihub.PluginsInstance("Collector", {
            plugin: plugin.name,
            displayName: "orders collector",
            actions: [{ actionId: "sync-metadata" }],
          });
          return { plugin, instance };
        }),
      );

      expect(created.instance.name).toContain("/instances/");
      expect(created.instance.plugin).toEqual(created.plugin.name);
      expect(created.instance.displayName).toEqual("orders collector");
      expect(created.instance.location).toEqual(location);

      const fetched = yield* apihub.getProjectsLocationsPluginsInstances({
        name: created.instance.name,
      });
      expect(fetched.name).toEqual(created.instance.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("orders collector");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const plugin = yield* GCP.Apihub.Plugin("OnRamp", {
            pluginId: created.plugin.pluginId,
            location,
            displayName: "on-ramp",
            description: "plugin for instance test",
          });
          const instance = yield* GCP.Apihub.PluginsInstance("Collector", {
            plugin: plugin.name,
            pluginInstanceId: created.instance.pluginInstanceId,
            displayName: "orders collector (updated)",
            actions: [{ actionId: "sync-metadata" }],
          });
          return { plugin, instance };
        }),
      );

      expect(updated.instance.name).toEqual(created.instance.name);
      expect(updated.instance.displayName).toEqual(
        "orders collector (updated)",
      );

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.instance.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
