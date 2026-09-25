import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gmail from "@distilled.cloud/gcp/gmail_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_GMAIL;

const waitUntilGone = (emailAddress: string) =>
  gmail
    .getUsersSettingsCseIdentities({
      userId: "me",
      cseEmailAddress: emailAddress,
    })
    .pipe(
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
  "getUsersSettingsCseIdentities on a missing identity fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersSettingsCseIdentities({
          userId: "me",
          cseEmailAddress: "missing@example.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "createUsersSettingsCseIdentities without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.createUsersSettingsCseIdentities({
          userId: "me",
          body: {
            emailAddress: "alchemy-cse@example.com",
            primaryKeyPairId: "kp-missing",
          },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a CSE identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsCseIdentity("Primary", {
            emailAddress: "alchemy-cse@example.com",
            primaryKeyPairId: "kp-1",
          });
        }),
      );

      expect(created.emailAddress.length).toBeGreaterThan(0);

      const fetched = yield* gmail.getUsersSettingsCseIdentities({
        userId: "me",
        cseEmailAddress: created.emailAddress,
      });
      expect(fetched.emailAddress).toEqual(created.emailAddress);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsCseIdentity("Primary", {
            emailAddress: created.emailAddress,
            primaryKeyPairId: "kp-2",
          });
        }),
      );

      expect(updated.emailAddress).toEqual(created.emailAddress);
      expect(updated.primaryKeyPairId).toEqual("kp-2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.emailAddress);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
