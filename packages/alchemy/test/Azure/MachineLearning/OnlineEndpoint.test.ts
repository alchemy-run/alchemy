import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  appInsightsId,
  baseDefault,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEndpoint = (
  resourceGroupName: string,
  workspaceName: string,
  endpointName: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetOnlineEndpoint({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      endpointName,
    });
  });

const program = (props: {
  authMode: "Key" | "AMLToken";
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const base = yield* baseDefault();
    const endpoint = yield* Azure.MachineLearning.OnlineEndpoint("Scoring", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      authMode: props.authMode,
      description: props.description,
      tags: props.tags,
    });
    return { ...base, endpoint };
  });

// An online endpoint without deployments has no compute and no hourly
// charge; ~6-10 minutes including a replacement. Hub workspaces reject
// online endpoints ("The request is invalid.") and in hub-based projects
// provisioning ends in `Failed`, so this needs a `Default` workspace, which
// needs an existing Application Insights component (AZURE_ML_APP_INSIGHTS_ID).
test.provider.skipIf(!appInsightsId)(
  "create, update, replace, and delete an online endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, endpoint } = yield* stack.deploy(
        program({ authMode: "Key", description: "v1", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getEndpoint(group.resourceGroupName, workspace.workspaceName, name);
      expect(endpoint.scoringUri).toContain("inference.ml.azure.com");
      expect(endpoint.authMode).toEqual("Key");
      const observed = yield* get(endpoint.endpointName);
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Scoring");

      // In-place: description and tags.
      const updated = yield* stack.deploy(
        program({ authMode: "Key", description: "v2", tags: { env: "prod" } }),
      );
      expect(updated.endpoint.endpointId).toEqual(endpoint.endpointId);
      const reobserved = yield* get(endpoint.endpointName);
      expect(reobserved.properties.description).toEqual("v2");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new auth mode.
      const replaced = yield* stack.deploy(
        program({
          authMode: "AMLToken",
          description: "v2",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.endpoint.endpointName).not.toEqual(endpoint.endpointName);
      const replacedObserved = yield* get(replaced.endpoint.endpointName);
      expect(replacedObserved.properties.authMode).toEqual("AMLToken");
      expect(yield* waitGone(get(endpoint.endpointName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.endpoint.endpointName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
