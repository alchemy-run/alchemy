import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  basicRegistry,
  getRegistry,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTask = (
  resourceGroupName: string,
  registryName: string,
  taskName: string,
) =>
  Effect.gen(function* () {
    return yield* containerregistry.GetTask({
      subscriptionId: yield* subscription,
      resourceGroupName,
      registryName,
      taskName,
    });
  });

const encode = (yaml: string) => Buffer.from(yaml).toString("base64");

const program = (props: {
  name?: string;
  cmd: string;
  schedule: string;
  status: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, registry } = yield* basicRegistry();
    const task = yield* Azure.ContainerRegistry.Task("Task", {
      resourceGroup: group.resourceGroupName,
      registry: registry.registryName,
      name: props.name,
      platform: { os: "Linux" },
      step: {
        type: "EncodedTask",
        encodedTaskContent: encode(
          `version: v1.1.0\nsteps:\n  - cmd: ${props.cmd}\n`,
        ),
      },
      timerTriggers: [{ name: "nightly", schedule: props.schedule }],
      status: props.status,
      timeout: 600,
      tags: props.tags,
    });
    return { group, registry, task };
  });

// ACR Tasks are disabled on free-trial / free-credit subscriptions
// (`TasksOperationsNotAllowed`). On a paid subscription: Basic registry
// (~$0.17/day), no runs triggered, about two minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a task",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, task } = yield* stack.deploy(
        program({
          cmd: "mcr.microsoft.com/hello-world",
          schedule: "0 3 * * *",
          status: "Enabled",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getTask(group.resourceGroupName, registry.registryName, name);
      expect(task.location).toEqual(registry.location);
      const observed = yield* get(task.taskName);
      expect(observed.properties?.step?.type).toEqual("EncodedTask");
      expect(observed.properties?.step?.encodedTaskContent).toEqual(
        encode(
          "version: v1.1.0\nsteps:\n  - cmd: mcr.microsoft.com/hello-world\n",
        ),
      );
      expect(
        observed.properties?.trigger?.timerTriggers?.[0]?.schedule,
      ).toEqual("0 3 * * *");
      expect(observed.properties?.timeout).toEqual(600);
      expect(observed.tags?.env).toEqual("test");

      // In-place: new step content, schedule, status, and tags.
      const updated = yield* stack.deploy(
        program({
          cmd: "mcr.microsoft.com/hello-world:latest",
          schedule: "0 4 * * *",
          status: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.task.taskId).toEqual(task.taskId);
      const reobserved = yield* get(task.taskName);
      expect(reobserved.properties?.status).toEqual("Disabled");
      expect(
        reobserved.properties?.trigger?.timerTriggers?.[0]?.schedule,
      ).toEqual("0 4 * * *");
      expect(reobserved.properties?.step?.encodedTaskContent).toEqual(
        encode(
          "version: v1.1.0\nsteps:\n  - cmd: mcr.microsoft.com/hello-world:latest\n",
        ),
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemytasktest",
          cmd: "mcr.microsoft.com/hello-world:latest",
          schedule: "0 4 * * *",
          status: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.task.taskName).toEqual("alchemytasktest");
      yield* get("alchemytasktest");
      expect(yield* waitGone(get(task.taskName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: the free trial rejects ACR Tasks with a typed error.
// Basic registry (~$0.17/day), about a minute.
test.provider(
  "the free trial rejects ACR Tasks with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry } = yield* stack.deploy(basicRegistry());
      const error = yield* containerregistry
        .CreateTask({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          registryName: registry.registryName,
          taskName: "probe",
          location: registry.location,
          properties: {
            platform: { os: "Linux" },
            step: {
              type: "EncodedTask",
              encodedTaskContent: encode(
                "version: v1.1.0\nsteps:\n  - cmd: mcr.microsoft.com/hello-world\n",
              ),
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("TasksOperationsNotAllowed");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
