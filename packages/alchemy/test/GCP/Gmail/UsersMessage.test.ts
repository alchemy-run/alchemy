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

const waitUntilGone = (messageId: string) =>
  gmail.getUsersMessages({ userId: "me", id: messageId }).pipe(
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
  "getUsersMessages on a missing message fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersMessages({ userId: "me", id: "msg-missing" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "insertUsersMessages without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const raw = yield* Effect.sync(() =>
        Buffer.from("Subject: probe\r\n\r\n").toString("base64url"),
      );
      const error = yield* Effect.flip(
        gmail.insertUsersMessages({
          userId: "me",
          body: { raw },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update labels, and delete a message",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersMessage("Note", {
            subject: "runbook",
            body: "keep this",
          });
        }),
      );

      expect(created.messageId.length).toBeGreaterThan(0);
      expect(created.subject).toEqual("runbook");

      const fetched = yield* gmail.getUsersMessages({
        userId: "me",
        id: created.messageId,
        format: "metadata",
      });
      expect(fetched.id).toEqual(created.messageId);
      const subject = fetched.payload?.headers?.find(
        (header) => header.name?.toLowerCase() === "subject",
      )?.value;
      expect(subject).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersMessage("Note", {
            messageId: created.messageId,
            subject: "runbook",
            body: "keep this",
            labelIds: ["STARRED"],
          });
        }),
      );

      expect(updated.messageId).toEqual(created.messageId);
      expect(updated.labelIds).toContain("STARRED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.messageId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
