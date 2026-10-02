import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { baseProject, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSchedule = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetSchedule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const jobDefinition = {
  jobType: "Command",
  command: "echo hello",
  environmentId:
    "azureml://registries/azureml/environments/sklearn-1.5/labels/latest",
  resources: { instanceType: "Standard_DS3_v2", instanceCount: 1 },
};

const program = (props: {
  expression: string;
  description: string;
  tags: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const base = yield* baseProject();
    const schedule = yield* Azure.MachineLearning.Schedule("Nightly", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: props.name,
      // Disabled: the job never runs.
      isEnabled: false,
      trigger: { triggerType: "Cron", expression: props.expression },
      action: { actionType: "CreateJob", jobDefinition },
      description: props.description,
      tags: props.tags,
    });
    return { ...base, schedule };
  });

// A disabled schedule never submits a job: no charge, ~4-6 minutes.
test.provider(
  "create, update, replace, and delete a schedule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, schedule } = yield* stack.deploy(
        program({
          expression: "0 2 * * *",
          description: "v1",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getSchedule(group.resourceGroupName, workspace.workspaceName, name);
      expect(schedule.isEnabled).toEqual(false);
      const observed = yield* get(schedule.scheduleName);
      expect(observed.properties.trigger.expression).toEqual("0 2 * * *");
      expect(observed.properties.action.actionType).toEqual("CreateJob");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.properties.tags?.env).toEqual("test");

      // In-place: trigger, description, and tags.
      const updated = yield* stack.deploy(
        program({
          expression: "0 3 * * *",
          description: "v2",
          tags: { env: "prod" },
        }),
      );
      expect(updated.schedule.scheduleId).toEqual(schedule.scheduleId);
      const reobserved = yield* get(schedule.scheduleName);
      expect(reobserved.properties.trigger.expression).toEqual("0 3 * * *");
      expect(reobserved.properties.description).toEqual("v2");
      expect(reobserved.properties.tags?.env).toEqual("prod");

      // Replacement: an explicit new name.
      const replaced = yield* stack.deploy(
        program({
          expression: "0 3 * * *",
          description: "v2",
          tags: { env: "prod" },
          name: "alchemy-nightly-r2",
        }),
      );
      expect(replaced.schedule.scheduleName).toEqual("alchemy-nightly-r2");
      yield* get("alchemy-nightly-r2");
      expect(yield* waitGone(get(schedule.scheduleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-nightly-r2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
