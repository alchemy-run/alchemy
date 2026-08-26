import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebase from "@distilled.cloud/gcp/firebase_v1beta1";
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
  hasGcpCreds && !!process.env.GCP_TEST_FIREBASE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  firebase.getProjectsAndroidApps({ name }).pipe(
    Effect.map((app) =>
      app.state === "DELETED" ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 8,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsAndroidApps on a missing app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebase.getProjectsAndroidApps({
          name: `projects/${project}/androidApps/1:1:android:missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createProjectsAndroidApps without Firebase fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebase.createProjectsAndroidApps({
          parent: `projects/${project}`,
          body: {
            packageName: "com.alchemy.test.probe",
            displayName: "alchemy-probe",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an android app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebase.AndroidApp("Mobile", {
            displayName: "mobile",
          });
        }),
      );

      expect(created.name).toContain("/androidApps/");
      expect(created.appId).toEqual(expect.any(String));
      expect(created.packageName).toContain("com.alchemy.test.");
      expect(created.displayName).toEqual("mobile");

      const fetched = yield* firebase.getProjectsAndroidApps({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebase.AndroidApp("Mobile", {
            packageName: created.packageName,
            displayName: "mobile-v2",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("mobile-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
