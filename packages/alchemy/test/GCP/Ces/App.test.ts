import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as ces from "@distilled.cloud/gcp/ces_v1";
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

// CES (Gemini Enterprise for Customer Experience) is entitlement-gated.
// Live create returns Forbidden: "Gemini Enterprise for Customer Experience
// API has not been used in project … or it is disabled."
const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_CES === "1";

const waitUntilGone = (name: string) =>
  ces.getProjectsLocationsApps({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApps on a missing app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        ces.getProjectsLocationsApps({
          name: `projects/${project}/locations/us-central1/apps/alchemy-missing-app`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Ces.App("Support", {
            displayName: "support",
            description: "help desk",
            timeZone: "America/Los_Angeles",
          });
        }),
      );

      expect(created.name).toContain("/apps/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("support");
      expect(created.description).toEqual("help desk");
      expect(created.timeZone).toEqual("America/Los_Angeles");

      const fetched = yield* ces.getProjectsLocationsApps({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.metadata?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Ces.App("Support", {
            appId: created.appId,
            location: created.location,
            displayName: "support-desk",
            description: "updated help desk",
            timeZone: "America/New_York",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("support-desk");
      expect(updated.description).toEqual("updated help desk");
      expect(updated.timeZone).toEqual("America/New_York");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
