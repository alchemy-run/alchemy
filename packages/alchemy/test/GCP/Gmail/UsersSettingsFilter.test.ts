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

const waitUntilGone = (filterId: string) =>
  gmail.getUsersSettingsFilters({ userId: "me", id: filterId }).pipe(
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
  "getUsersSettingsFilters on a missing filter fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.getUsersSettingsFilters({ userId: "me", id: "filter-missing" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_GMAIL)(
  "createUsersSettingsFilters without Gmail access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        gmail.createUsersSettingsFilters({
          userId: "me",
          body: {
            criteria: { subject: "Alchemy Gmail Probe" },
            action: { addLabelIds: ["STARRED"] },
          },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete a filter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsFilter("StarNotes", {
            criteria: { subject: "runbook" },
            action: { addLabelIds: ["STARRED"] },
          });
        }),
      );

      expect(created.filterId.length).toBeGreaterThan(0);
      expect(created.criteria?.subject).toEqual("runbook");

      const fetched = yield* gmail.getUsersSettingsFilters({
        userId: "me",
        id: created.filterId,
      });
      expect(fetched.id).toEqual(created.filterId);
      expect(fetched.criteria?.subject).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Gmail.UsersSettingsFilter("StarNotes", {
            criteria: { subject: "runbook" },
            action: { addLabelIds: ["IMPORTANT"] },
          });
        }),
      );

      expect(updated.action?.addLabelIds).toContain("IMPORTANT");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.filterId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
