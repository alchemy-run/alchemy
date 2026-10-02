import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly, withVcpus } from "../gates.ts";
import {
  appInsightsId,
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
    return yield* ml.GetOnlineDeployment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      endpointName,
      deploymentName,
    });
  });

const program = (props: { tags: Record<string, string>; timeout: string }) =>
  Effect.gen(function* () {
    const base = yield* baseDefault();
    const endpoint = yield* Azure.MachineLearning.OnlineEndpoint("Scoring", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
    });
    const deployment = yield* Azure.MachineLearning.OnlineDeployment("Blue", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      endpoint: endpoint.endpointName,
      name: "blue",
      model:
        "azureml://registries/azureml/models/distilbert-base-uncased-finetuned-sst-2-english/labels/latest",
      instanceType: "Standard_DS3_v2",
      instanceCount: 1,
      requestSettings: { requestTimeout: props.timeout },
      tags: props.tags,
    });
    return { ...base, endpoint, deployment };
  });

// A managed deployment runs a dedicated Standard_DS3_v2 (4 vCPUs, ~$0.30/h,
// plus a 20% surge reservation) and takes 10-20 minutes to provision. The
// free trial has no managed online endpoint VM quota, and the endpoint
// needs a `Default` workspace (AZURE_ML_APP_INSIGHTS_ID).
test.provider.skipIf(!runPaidOnly || !appInsightsId)(
  "create, update, and delete an online deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, endpoint, deployment } = yield* stack.deploy(
        program({ tags: { env: "test" }, timeout: "PT5S" }),
      );
      const get = () =>
        getDeployment(
          group.resourceGroupName,
          workspace.workspaceName,
          endpoint.endpointName,
          deployment.deploymentName,
        );
      const observed = yield* get();
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place: request settings (rolling update) and tags.
      yield* stack.deploy(program({ tags: { env: "prod" }, timeout: "PT10S" }));
      const reobserved = yield* get();
      expect(reobserved.properties.requestSettings?.requestTimeout).toEqual(
        "PT10S",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(withVcpus(4), logLevel),
  { tags, timeout: 900_000 },
);
