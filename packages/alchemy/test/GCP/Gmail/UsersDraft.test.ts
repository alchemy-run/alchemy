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

const waitUntilGone = (draftId: string) =>
  gmail.getUsersDrafts({ userId: "me", id: draftId }).pipe(
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
  "getUsersDrafts on a missing draft fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersDrafts({ userId: "me", id: "draft-missing" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "createUsersDrafts without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const raw = yield* Effect.sync(() =>
        Buffer.from("Subject: probe\r\n\r\n").toString("base64url"),
      );
      const error = yield* Effect.flip(
        gmail.createUsersDrafts({
          userId: "me",
          body: { message: { raw } },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a draft",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersDraft("FollowUp", {
            subject: "Q2 follow-up",
            to: "ada@example.com",
            body: "circling back",
          });
        }),
      );

      expect(created.draftId.length).toBeGreaterThan(0);
      expect(created.subject).toEqual("Q2 follow-up");

      const fetched = yield* gmail.getUsersDrafts({
        userId: "me",
        id: created.draftId,
        format: "metadata",
      });
      expect(fetched.id).toEqual(created.draftId);
      const subject = fetched.message?.payload?.headers?.find(
        (header) => header.name?.toLowerCase() === "subject",
      )?.value;
      expect(subject).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersDraft("FollowUp", {
            draftId: created.draftId,
            subject: "Q2 follow-up",
            to: "ada@example.com",
            body: "updated notes",
          });
        }),
      );

      expect(updated.draftId).toEqual(created.draftId);
      expect(updated.body).toContain("updated notes");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.draftId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
