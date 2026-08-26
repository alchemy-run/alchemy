import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { requireAccountPath } from "./parent.ts";

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

const waitUntilGone = (path: string) =>
  tagmanager.getAccountsUser_permissions({ path }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsUser_permissions on a missing user permission fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tagmanager.getAccountsUser_permissions({
          path: "accounts/0/user_permissions/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !!process.env.FAST || !process.env.GCP_TEST_TAGMANAGER,
)(
  "create, update, and delete a user permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const accountPath = yield* requireAccountPath();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.User("Analyst", {
            account: accountPath,
            emailAddress: "alc.tagmanager2.analyst@example.com",
            accountAccess: { permission: "user" },
          });
        }),
      );

      expect(created.path).toContain("/user_permissions/");
      expect(created.account).toEqual(accountPath);
      expect(created.emailAddress).toEqual(
        "alc.tagmanager2.analyst@example.com",
      );
      expect(created.accountAccess?.permission).toEqual("user");

      const fetched = yield* tagmanager.getAccountsUser_permissions({
        path: created.path,
      });
      expect(fetched.path).toEqual(created.path);
      expect(fetched.emailAddress).toEqual(created.emailAddress);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tagmanager.User("Analyst", {
            account: accountPath,
            userPermissionId: created.userPermissionId,
            emailAddress: created.emailAddress,
            accountAccess: { permission: "user" },
            containerAccess: [],
          });
        }),
      );

      expect(updated.path).toEqual(created.path);
      expect(updated.emailAddress).toEqual(created.emailAddress);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.path);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
