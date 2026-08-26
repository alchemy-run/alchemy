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

const waitUntilGone = (labelId: string) =>
  gmail.getUsersLabels({ userId: "me", id: labelId }).pipe(
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
  "getUsersLabels on a missing label fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersLabels({ userId: "me", id: "Label_missing" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "createUsersLabels without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.createUsersLabels({
          userId: "me",
          body: { name: "Alchemy Gmail Probe" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersLabel("Receipts", {
            name: "Receipts",
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          });
        }),
      );

      expect(created.labelId.length).toBeGreaterThan(0);
      expect(created.name).toEqual("Receipts");

      const fetched = yield* gmail.getUsersLabels({
        userId: "me",
        id: created.labelId,
      });
      expect(fetched.id).toEqual(created.labelId);
      expect(fetched.name).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersLabel("Receipts", {
            labelId: created.labelId,
            name: "Receipts 2026",
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          });
        }),
      );

      expect(updated.labelId).toEqual(created.labelId);
      expect(updated.name).toEqual("Receipts 2026");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.labelId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
