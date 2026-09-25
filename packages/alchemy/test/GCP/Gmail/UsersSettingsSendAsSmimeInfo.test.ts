import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gmail from "@distilled.cloud/gcp/gmail_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  SMIME_PASSWORD,
  SMIME_PKCS12_A,
  SMIME_PKCS12_B,
} from "./fixtures/smime.ts";

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

const gmailUser = process.env.GCP_TEST_GMAIL_USER;
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_GMAIL &&
  !!gmailUser;

const waitUntilGone = (
  userId: string,
  sendAsEmail: string,
  smimeInfoId: string,
) =>
  gmail
    .getUsersSettingsSendAsSmimeInfo({
      userId,
      sendAsEmail,
      id: smimeInfoId,
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
  "getUsersSettingsSendAsSmimeInfo on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersSettingsSendAsSmimeInfo({
          userId: "me",
          sendAsEmail: "nobody@example.com",
          id: "missing-smime",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "insertUsersSettingsSendAsSmimeInfo without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.insertUsersSettingsSendAsSmimeInfo({
          userId: "me",
          sendAsEmail: "nobody@example.com",
          body: {
            pkcs12: SMIME_PKCS12_A,
            encryptedKeyPassword: SMIME_PASSWORD,
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, replace, and delete an S/MIME config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const sendAsEmail = gmailUser!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsSendAsSmimeInfo("Work", {
            sendAsEmail,
            pkcs12: SMIME_PKCS12_A,
            encryptedKeyPassword: SMIME_PASSWORD,
          });
        }),
      );

      expect(created.sendAsEmail).toEqual(sendAsEmail);
      expect(created.smimeInfoId.length).toBeGreaterThan(0);
      expect(created.issuerCn?.toLowerCase()).toContain("alchemy-test-smime-a");

      const fetched = yield* gmail.getUsersSettingsSendAsSmimeInfo({
        userId: created.userId,
        sendAsEmail: created.sendAsEmail,
        id: created.smimeInfoId,
      });
      expect(fetched.id).toEqual(created.smimeInfoId);
      expect(fetched.issuerCn?.toLowerCase()).toContain("alchemy-test-smime-a");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsSendAsSmimeInfo("Work", {
            sendAsEmail,
            smimeInfoId: created.smimeInfoId,
            pkcs12: SMIME_PKCS12_A,
            encryptedKeyPassword: SMIME_PASSWORD,
            isDefault: true,
          });
        }),
      );

      expect(updated.smimeInfoId).toEqual(created.smimeInfoId);
      expect(updated.isDefault).toEqual(true);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsSendAsSmimeInfo("Work", {
            sendAsEmail,
            pkcs12: SMIME_PKCS12_B,
            encryptedKeyPassword: SMIME_PASSWORD,
            isDefault: true,
          });
        }),
      );

      expect(replaced.smimeInfoId.length).toBeGreaterThan(0);
      expect(replaced.smimeInfoId).not.toEqual(created.smimeInfoId);
      expect(replaced.issuerCn?.toLowerCase()).toContain(
        "alchemy-test-smime-b",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        replaced.userId,
        replaced.sendAsEmail,
        replaced.smimeInfoId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
