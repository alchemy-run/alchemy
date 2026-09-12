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
  apigee.getOrganizationsAppgroupsAppsKeys({ name }).pipe(
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
  "getOrganizationsAppgroupsAppsKeys on a missing key fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsAppgroupsAppsKeys({
          name: `${org}/appgroups/missing-group/apps/missing-app/keys/missing-key`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an appgroup app key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* apigee.createOrganizationsAppgroups({
        parent: org,
        body: { name: "alchemy-appgroup", displayName: "alchemy-appgroup" },
      });
      const groupId = group.name ?? "alchemy-appgroup";
      const groupParent = groupId.includes("/appgroups/")
        ? groupId
        : `${org}/appgroups/${groupId}`;

      const app = yield* apigee.createOrganizationsAppgroupsApps({
        parent: groupParent,
        body: { name: "alchemy-app" },
      });
      const appName = app.name ?? "alchemy-app";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.AppgroupsAppsKey("GroupKey", {
            appGroup: groupId,
            app: appName,
            attributes: { team: "platform" },
          });
        }),
      );

      expect(created.consumerKey).toEqual(expect.any(String));
      expect(created.attributes).toMatchObject({ team: "platform" });

      const fetched = yield* apigee.getOrganizationsAppgroupsAppsKeys({
        name: created.name,
      });
      expect(fetched.consumerKey).toEqual(created.consumerKey);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.AppgroupsAppsKey("GroupKey", {
            appGroup: groupId,
            app: appName,
            consumerKey: created.consumerKey,
            consumerSecret: created.consumerSecret,
            attributes: { team: "runtime" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.attributes).toMatchObject({ team: "runtime" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");

      yield* apigee
        .deleteOrganizationsAppgroupsApps({
          name: `${groupParent}/apps/${appName}`,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* apigee
        .deleteOrganizationsAppgroups({ name: groupParent })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }).pipe(logLevel),
  { timeout: 90_000 },
);
