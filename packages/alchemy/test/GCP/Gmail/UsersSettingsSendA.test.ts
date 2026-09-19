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

const waitUntilGone = (sendAsEmail: string) =>
  gmail.getUsersSettingsSendAs({ userId: "me", sendAsEmail }).pipe(
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
  "getUsersSettingsSendAs on a missing alias fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersSettingsSendAs({
          userId: "me",
          sendAsEmail: "missing@example.com",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "createUsersSettingsSendAs without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.createUsersSettingsSendAs({
          userId: "me",
          body: {
            sendAsEmail: "alchemy-probe@example.com",
            displayName: "Alchemy",
          },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a send-as alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsSendA("Support", {
            sendAsEmail: "alchemy-support@example.com",
            displayName: "Support",
            signature: "Thanks",
            treatAsAlias: true,
          });
        }),
      );

      expect(created.sendAsEmail).toEqual("alchemy-support@example.com");
      expect(created.signature).toEqual("Thanks");

      const fetched = yield* gmail.getUsersSettingsSendAs({
        userId: "me",
        sendAsEmail: created.sendAsEmail,
      });
      expect(fetched.sendAsEmail).toEqual(created.sendAsEmail);
      expect(fetched.signature).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsSendA("Support", {
            sendAsEmail: created.sendAsEmail,
            displayName: "Support",
            signature: "Best",
            treatAsAlias: true,
          });
        }),
      );

      expect(updated.sendAsEmail).toEqual(created.sendAsEmail);
      expect(updated.signature).toEqual("Best");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.sendAsEmail);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
