import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  baseProject,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const modelId =
  "azureml://registries/azureml-meta/models/Meta-Llama-3-8B-Instruct";

const getEndpoint = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetServerlessEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const base = yield* baseProject();
    const endpoint = yield* Azure.MachineLearning.ServerlessEndpoint("Llama", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      modelId,
      tags: props.tags,
    });
    return { ...base, endpoint };
  });

// Serverless endpoints for non-Microsoft models need an Azure Marketplace
// subscription, which the free trial blocks. Pay-per-token only (no
// hourly charge); ~5-10 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a serverless endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, endpoint } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getEndpoint(group.resourceGroupName, workspace.workspaceName, name);
      expect(endpoint.inferenceUri).toBeTruthy();
      const observed = yield* get(endpoint.endpointName);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.endpoint.endpointId).toEqual(endpoint.endpointId);
      expect((yield* get(endpoint.endpointName)).tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get(endpoint.endpointName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the free trial is not offered catalog models-as-a-service
// (non-Microsoft models need an Azure Marketplace subscription), so the
// create is rejected with the typed error (hub + project have no hourly
// charge; ~3-5 minutes).
test.provider(
  "a serverless endpoint for an unavailable model is rejected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, workspace } = yield* stack.deploy(baseProject());
      const error = yield* ml
        .ServerlessEndpointsCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          workspaceName: workspace.workspaceName,
          name: "probe-serverless",
          location,
          sku: { name: "Consumption" },
          properties: { authMode: "Key", modelSettings: { modelId } },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MachineLearningModelNotAvailable");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
