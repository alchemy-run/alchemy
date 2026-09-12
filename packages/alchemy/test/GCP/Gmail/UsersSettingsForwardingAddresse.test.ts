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

const waitUntilGone = (forwardingEmail: string) =>
  gmail
    .getUsersSettingsForwardingAddresses({ userId: "me", forwardingEmail })
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
  "getUsersSettingsForwardingAddresses on a missing address fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersSettingsForwardingAddresses({
          userId: "me",
          forwardingEmail: "missing@example.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "createUsersSettingsForwardingAddresses without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.createUsersSettingsForwardingAddresses({
          userId: "me",
          body: { forwardingEmail: "alchemy-forward@example.com" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a forwarding address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsForwardingAddresse("Backup", {
            forwardingEmail: "alchemy-forward@example.com",
          });
        }),
      );

      expect(created.forwardingEmail).toEqual("alchemy-forward@example.com");

      const fetched = yield* gmail.getUsersSettingsForwardingAddresses({
        userId: "me",
        forwardingEmail: created.forwardingEmail,
      });
      expect(fetched.forwardingEmail).toEqual(created.forwardingEmail);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.forwardingEmail);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
