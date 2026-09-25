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

test.provider.skipIf(!hasGcpCreds)(
  "CreateTask enqueues an HTTP task",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const task = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* GCP.CloudTasks.Queue("Jobs", {
            location: "us-central1",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* queue.name;
              const createTask = yield* GCP.CloudTasks.CreateTask(queue);
              return Effect.fn(function* () {
                return yield* createTask({
                  body: {
                    task: {
                      httpRequest: {
                        url: "https://example.com/jobs",
                        httpMethod: "POST",
                        body: btoa(JSON.stringify({ id: "1" })),
                      },
                    },
                  },
                });
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(task.name).toContain("/tasks/");
      expect(task.httpRequest?.url).toEqual("https://example.com/jobs");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
