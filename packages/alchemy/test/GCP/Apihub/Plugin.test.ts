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
  apihub.getProjectsLocationsPlugins({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsPlugins on a missing plugin fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsPlugins({
          name: `projects/${project}/locations/${location}/plugins/alchemy-missing-plugin`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, disable, and delete an API Hub plugin",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apihub.Plugin("OnRamp", {
            location,
            displayName: "on-ramp",
            description: "custom collector",
          });
        }),
      );

      expect(created.name).toContain("/plugins/");
      expect(created.pluginId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.displayName).toEqual("on-ramp");
      expect(created.description).toEqual("custom collector");
      expect(created.pluginCategory).toEqual("API_PRODUCER");

      const fetched = yield* apihub.getProjectsLocationsPlugins({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("custom collector");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apihub.Plugin("OnRamp", {
            pluginId: created.pluginId,
            location,
            displayName: "on-ramp",
            description: "custom collector",
            enabled: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(
        updated.state === "DISABLED" || updated.state === undefined,
      ).toEqual(true);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
