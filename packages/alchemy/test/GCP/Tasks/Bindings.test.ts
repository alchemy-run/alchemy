import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

test.provider.skipIf(!runLifecycle)(
  "GetTasklist and GetTask round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const list = yield* GCP.Tasks.Tasklist("Inbox", {
            title: "Engineering",
          });
          const item = yield* GCP.Tasks.Task("Ship", {
            tasklistId: list.tasklistId,
            title: "Ship the release",
            notes: "Cut 2.0",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* list.tasklistId;
              yield* item.taskId;
              const getTasklist = yield* GCP.Tasks.GetTasklist(list);
              const getTask = yield* GCP.Tasks.GetTask(item);
              return Effect.fn(function* () {
                const listMeta = yield* getTasklist({});
                const taskMeta = yield* getTask({});
                return { listMeta, taskMeta };
              });
            }),
          );
          return { list, item, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.listMeta.id).toEqual(out.list.tasklistId);
      expect(out.probe.listMeta.title).toContain("Engineering");
      expect(out.probe.taskMeta.id).toEqual(out.item.taskId);
      expect(out.probe.taskMeta.title).toEqual("Ship the release");
      expect(out.probe.taskMeta.notes).toContain("[alchemy ");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
