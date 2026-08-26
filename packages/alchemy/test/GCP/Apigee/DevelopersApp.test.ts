import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
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
  hasGcpCreds && !!process.env.GCP_TEST_APIGEE && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const org = `organizations/${project}`;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsDevelopersApps({ name }).pipe(
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
  "getOrganizationsDevelopersApps on a missing app fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsDevelopersApps({
          name: `${org}/developers/missing@alchemy.example/apps/missing-app`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a developer app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const developer = yield* GCP.Apigee.Developer("Owner", {
            firstName: "Ada",
            lastName: "Lovelace",
          });
          const app = yield* GCP.Apigee.DevelopersApp("Portal", {
            developer: developer.email,
            callbackUrl: "https://example.com/callback",
            attributes: { team: "platform" },
          });
          return { developer, app };
        }),
      );

      expect(created.app.appName).toEqual(expect.any(String));
      expect(created.app.callbackUrl).toEqual("https://example.com/callback");
      expect(created.app.attributes).toMatchObject({ team: "platform" });

      const fetched = yield* apigee.getOrganizationsDevelopersApps({
        name: created.app.name,
      });
      expect(fetched.name).toEqual(created.app.appName);
      expect(
        fetched.attributes?.some((item) => item.name === "alchemy-id"),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const developer = yield* GCP.Apigee.Developer("Owner", {
            email: created.developer.email,
            firstName: "Ada",
            lastName: "Lovelace",
          });
          const app = yield* GCP.Apigee.DevelopersApp("Portal", {
            developer: developer.email,
            appName: created.app.appName,
            callbackUrl: "https://example.com/updated",
            attributes: { team: "runtime" },
          });
          return { developer, app };
        }),
      );

      expect(updated.app.name).toEqual(created.app.name);
      expect(updated.app.callbackUrl).toEqual("https://example.com/updated");
      expect(updated.app.attributes).toMatchObject({ team: "runtime" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.app.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
