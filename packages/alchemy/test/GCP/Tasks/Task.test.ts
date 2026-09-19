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

const waitUntilGone = (tasklistId: string, taskId: string) =>
  tasks.getTasks({ tasklist: tasklistId, task: taskId }).pipe(
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
  "getTasks on a missing task fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tasks.getTasks({
          tasklist: "@default",
          task: "alchemyMissingTaskId000",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_TASKS)(
  "insertTasks without Tasks access fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        tasks.insertTasks({
          tasklist: "@default",
          body: { title: "Alchemy Task Probe" },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a task",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* GCP.Tasks.Tasklist("Inbox", {
            title: "Engineering",
          });
          return yield* GCP.Tasks.Task("Ship", {
            tasklistId: list.tasklistId,
            title: "Ship the release",
            notes: "Cut 2.0",
            status: "needsAction",
          });
        }),
      );

      expect(created.taskId.length).toBeGreaterThan(0);
      expect(created.tasklistId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Ship the release");
      expect(created.notes).toEqual("Cut 2.0");
      expect(created.status).toEqual("needsAction");

      const fetched = yield* tasks.getTasks({
        tasklist: created.tasklistId,
        task: created.taskId,
      });
      expect(fetched.id).toEqual(created.taskId);
      expect(fetched.notes).toContain("[alchemy ");
      expect(fetched.title).toEqual("Ship the release");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* GCP.Tasks.Tasklist("Inbox", {
            tasklistId: created.tasklistId,
            title: "Engineering",
          });
          return yield* GCP.Tasks.Task("Ship", {
            tasklistId: list.tasklistId,
            taskId: created.taskId,
            title: "Ship the release (done)",
            notes: "Cut 2.0",
            status: "completed",
          });
        }),
      );

      expect(updated.taskId).toEqual(created.taskId);
      expect(updated.title).toEqual("Ship the release (done)");
      expect(updated.status).toEqual("completed");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.tasklistId, created.taskId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
