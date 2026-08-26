import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as tasks from "@distilled.cloud/gcp/tasks_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_TASKS;

const waitUntilGone = (tasklistId: string) =>
  tasks.getTasklists({ tasklist: tasklistId }).pipe(
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
  "getTasklists on a missing list fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tasks.getTasklists({
          tasklist: "alchemyMissingTasklistId000",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_TASKS)(
  "insertTasklists without Tasks access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tasks.insertTasklists({
          body: { title: "Alchemy Tasklist Probe" },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a task list",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tasks.Tasklist("Inbox", {
            title: "Engineering",
          });
        }),
      );

      expect(created.tasklistId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Engineering");

      const fetched = yield* tasks.getTasklists({
        tasklist: created.tasklistId,
      });
      expect(fetched.id).toEqual(created.tasklistId);
      expect(fetched.title).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Tasks.Tasklist("Inbox", {
            tasklistId: created.tasklistId,
            title: "Platform",
          });
        }),
      );

      expect(updated.tasklistId).toEqual(created.tasklistId);
      expect(updated.title).toEqual("Platform");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.tasklistId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
