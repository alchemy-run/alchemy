import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DFAREPORTING;

const waitUntilGone = (profileId: string, userRoleId: string) =>
  dfa.getUserRoles({ profileId, id: userRoleId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const resolveProfileId = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GCP_DFAREPORTING_PROFILE_ID?.trim();
    if (fromEnv) return fromEnv;
    const profiles = yield* dfa.listUserProfiles({});
    return profiles.items?.find((profile) => profile.profileId)?.profileId;
  });

const resolveParentUserRoleId = (profileId: string) =>
  Effect.gen(function* () {
    const fromEnv = process.env.GCP_DFAREPORTING_PARENT_USER_ROLE_ID?.trim();
    if (fromEnv) return fromEnv;
    const listed = yield* dfa.listUserRoles({
      profileId,
      accountUserRoleOnly: true,
      maxResults: 1000,
    });
    return listed.userRoles?.find(
      (role) => role.defaultUserRole === true && !!role.id,
    )?.id;
  });

test.provider.skipIf(!hasGcpCreds)(
  "getUserRoles on a missing role fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getUserRoles({ profileId: "1", id: "1" }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertUserRoles without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertUserRoles({
          profileId: "1",
          body: {
            name: "alchemy-dfareporting-probe",
            parentUserRoleId: "1",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a user role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));
      const parentUserRoleId = yield* resolveParentUserRoleId(profileId!);
      expect(parentUserRoleId).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.UserRole("Analyst", {
            profileId: profileId!,
            parentUserRoleId,
            name: "analyst",
          });
        }),
      );

      expect(created.userRoleId).toEqual(expect.any(String));
      expect(created.profileId).toEqual(profileId);
      expect(created.name).toEqual("analyst");
      expect(created.defaultUserRole).toEqual(false);

      const fetched = yield* dfa.getUserRoles({
        profileId: created.profileId,
        id: created.userRoleId,
      });
      expect(fetched.id).toEqual(created.userRoleId);
      expect(fetched.name).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.UserRole("Analyst", {
            profileId: created.profileId,
            userRoleId: created.userRoleId,
            parentUserRoleId: created.parentUserRoleId,
            name: "analyst-v2",
          });
        }),
      );

      expect(updated.userRoleId).toEqual(created.userRoleId);
      expect(updated.name).toEqual("analyst-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.profileId, created.userRoleId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
