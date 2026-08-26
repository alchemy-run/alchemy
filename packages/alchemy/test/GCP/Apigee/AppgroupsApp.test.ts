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
  apigee.getOrganizationsAppgroupsApps({ name }).pipe(
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
  "getOrganizationsAppgroupsApps on a missing app fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsAppgroupsApps({
          name: `${org}/appgroups/missing-group/apps/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an appgroup app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.Apigee.Appgroup("Partners", {
            displayName: "Partners",
            email: "partners@example.com",
          });
          const app = yield* GCP.Apigee.AppgroupsApp("Mobile", {
            appgroup: group.appgroupId,
            callbackUrl: "https://example.com/oauth",
            attributes: [{ name: "team", value: "platform" }],
          });
          return { group, app };
        }),
      );

      expect(created.app.appId).toEqual(expect.any(String));
      expect(created.app.appgroupId).toEqual(created.group.appgroupId);
      expect(created.app.callbackUrl).toEqual("https://example.com/oauth");
      expect(created.app.attributes).toEqual(
        expect.arrayContaining([{ name: "team", value: "platform" }]),
      );

      const fetched = yield* apigee.getOrganizationsAppgroupsApps({
        name: created.app.name,
      });
      expect(
        fetched.attributes?.some((item) => item.name === "alchemy-id"),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.Apigee.Appgroup("Partners", {
            appgroupId: created.group.appgroupId,
            displayName: "Partners",
            email: "partners@example.com",
          });
          const app = yield* GCP.Apigee.AppgroupsApp("Mobile", {
            appgroup: group.appgroupId,
            appId: created.app.appId,
            callbackUrl: "https://example.com/updated",
            attributes: [{ name: "team", value: "runtime" }],
          });
          return { group, app };
        }),
      );

      expect(updated.app.name).toEqual(created.app.name);
      expect(updated.app.callbackUrl).toEqual("https://example.com/updated");
      expect(updated.app.attributes).toEqual(
        expect.arrayContaining([{ name: "team", value: "runtime" }]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.app.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
