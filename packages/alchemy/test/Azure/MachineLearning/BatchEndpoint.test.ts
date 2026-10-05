import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { baseProject, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetBatchEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      endpointName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const base = yield* baseProject();
    const endpoint = yield* Azure.MachineLearning.BatchEndpoint("Nightly", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: props.name,
      description: props.description,
      tags: props.tags,
    });
    return { ...base, endpoint };
  });

// A batch endpoint without deployments has no compute and no hourly
// charge; ~5-8 minutes including a replacement.
test.provider(
  "create, update, replace, and delete an batch endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, endpoint } = yield* stack.deploy(
        program({ description: "v1", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getEndpoint(group.resourceGroupName, workspace.workspaceName, name);
      expect(endpoint.scoringUri).toContain("inference.ml.azure.com");
      expect(endpoint.authMode).toEqual("AADToken");
      const observed = yield* get(endpoint.endpointName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Nightly");

      // In-place: description and tags.
      const updated = yield* stack.deploy(
        program({ description: "v2", tags: { env: "prod" } }),
      );
      expect(updated.endpoint.endpointId).toEqual(endpoint.endpointId);
      const reobserved = yield* get(endpoint.endpointName);
      expect(reobserved.properties.description).toEqual("v2");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: an explicit new name.
      const replaced = yield* stack.deploy(
        program({
          name: `${endpoint.endpointName.slice(0, 28)}-r2`,
          description: "v2",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.endpoint.endpointName).not.toEqual(endpoint.endpointName);
      const replacedObserved = yield* get(replaced.endpoint.endpointName);
      expect(replacedObserved.properties.description).toEqual("v2");
      expect(yield* waitGone(get(endpoint.endpointName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.endpoint.endpointName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
