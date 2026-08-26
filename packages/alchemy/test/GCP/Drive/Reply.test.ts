import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as drive from "@distilled.cloud/gcp/drive_v3";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DRIVE;

const waitUntilGone = (fileId: string, commentId: string, replyId: string) =>
  drive
    .getReplies({
      fileId,
      commentId,
      replyId,
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
  "getReplies on a missing reply fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.getReplies({
          fileId: "alchemyMissingFileId000000000000",
          commentId: "AAAA",
          replyId: "BBBB",
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DRIVE)(
  "createReplies without Drive access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        drive.createReplies({
          fileId: "alchemyMissingFileId000000000000",
          commentId: "AAAA",
          body: { content: "Alchemy Drive Probe" },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a reply",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* GCP.Drive.File("Doc", {
            name: "reply-doc",
          });
          const comment = yield* GCP.Drive.Comment("Kickoff", {
            fileId: file.fileId,
            content: "please review",
          });
          return yield* GCP.Drive.Reply("Ack", {
            fileId: file.fileId,
            commentId: comment.commentId,
            content: "will fix",
          });
        }),
      );

      expect(created.replyId.length).toBeGreaterThan(0);
      expect(created.commentId.length).toBeGreaterThan(0);
      expect(created.content).toEqual("will fix");

      const fetched = yield* drive.getReplies({
        fileId: created.fileId,
        commentId: created.commentId,
        replyId: created.replyId,
      });
      expect(fetched.id).toEqual(created.replyId);
      expect(fetched.content).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const file = yield* GCP.Drive.File("Doc", {
            fileId: created.fileId,
            name: "reply-doc",
          });
          const comment = yield* GCP.Drive.Comment("Kickoff", {
            fileId: file.fileId,
            commentId: created.commentId,
            content: "please review",
          });
          return yield* GCP.Drive.Reply("Ack", {
            fileId: file.fileId,
            commentId: comment.commentId,
            replyId: created.replyId,
            content: "fixed in rev 2",
          });
        }),
      );

      expect(updated.replyId).toEqual(created.replyId);
      expect(updated.content).toEqual("fixed in rev 2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.fileId,
        created.commentId,
        created.replyId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
