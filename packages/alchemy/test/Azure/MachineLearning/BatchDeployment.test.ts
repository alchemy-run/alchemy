import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  baseDefault,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDeployment = (
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
  deploymentName: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetBatchDeployment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      endpointName,
      deploymentName,
    });
  });

const program = (props: {
  tags: Record<string, string>;
  miniBatchSize: number;
}) =>
  Effect.gen(function* () {
    const base = yield* baseDefault();
    const cluster = yield* Azure.MachineLearning.Compute("Cpu", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      vmSize: "Standard_DS3_v2",
      scaleSettings: { minNodeCount: 0, maxNodeCount: 1 },
    });
    const endpoint = yield* Azure.MachineLearning.BatchEndpoint("Nightly", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
    });
    const deployment = yield* Azure.MachineLearning.BatchDeployment("V1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      endpoint: endpoint.endpointName,
      compute: cluster.computeId,
      model:
        "azureml://registries/azureml/models/distilbert-base-uncased-finetuned-sst-2-english/labels/latest",
      miniBatchSize: props.miniBatchSize,
      tags: props.tags,
    });
    return { ...base, endpoint, deployment };
  });

// The deployment and the minNodeCount-0 cluster are free until a job runs
// (none does). Needs AmlCompute, i.e. a `Default` workspace (with a
// template-deployed Application Insights component); ~8-12 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a batch deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, endpoint, deployment } = yield* stack.deploy(
        program({ tags: { env: "test" }, miniBatchSize: 10 }),
      );
      const get = () =>
        getDeployment(
          group.resourceGroupName,
          workspace.workspaceName,
          endpoint.endpointName,
          deployment.deploymentName,
        );
      const observed = yield* get();
      expect(observed.properties.miniBatchSize).toEqual(10);
      expect(observed.tags?.env).toEqual("test");

      // In-place: mini batch size (PUT) and tags (PATCH).
      yield* stack.deploy(program({ tags: { env: "prod" }, miniBatchSize: 5 }));
      const reobserved = yield* get();
      expect(reobserved.properties.miniBatchSize).toEqual(5);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
