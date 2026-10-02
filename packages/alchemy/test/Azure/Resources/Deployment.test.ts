import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm.ts";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const template = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: { name: { type: "string" } },
  resources: [
    {
      type: "Microsoft.ManagedIdentity/userAssignedIdentities",
      apiVersion: "2023-01-31",
      name: "alchemy-deployment-test-identity",
      location: "[resourceGroup().location]",
    },
  ],
  outputs: {
    greeting: {
      type: "string",
      value: "[concat('hello ', parameters('name'))]",
    },
  },
};

const getDeployment = (resourceGroupName: string, deploymentName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetDeployment({
        subscriptionId,
        resourceGroupName,
        deploymentName,
      }),
    );
  });

const deploymentGone = (resourceGroupName: string, deploymentName: string) =>
  getDeployment(resourceGroupName, deploymentName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 20,
    }),
  );

const program = (name: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const deployment = yield* Azure.Resources.Deployment("Greeting", {
      resourceGroup: group.resourceGroupName,
      template,
      parameters: { name },
      tags: { purpose: "test" },
    });
    return { group, deployment };
  });

test.provider(
  "deploy a template, re-run on a parameter change, skip no-op runs, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, deployment } = yield* stack.deploy(program("world"));
      expect(deployment.provisioningState).toEqual("Succeeded");
      expect(deployment.outputs).toEqual({ greeting: "hello world" });
      expect(
        deployment.outputResources.some((id) =>
          id.endsWith("/alchemy-deployment-test-identity"),
        ),
      ).toBe(true);
      expect(deployment.tags).toEqual({ purpose: "test" });
      const observed = yield* getDeployment(
        group.resourceGroupName,
        deployment.deploymentName,
      );
      expect(observed?.tags?.["alchemy::id"]).toEqual("Greeting");

      // Unchanged inputs do not start a new run.
      const again = yield* stack.deploy(program("world"));
      expect(again.deployment.correlationId).toEqual(deployment.correlationId);

      // A parameter change re-runs the deployment in place.
      const updated = yield* stack.deploy(program("azure"));
      expect(updated.deployment.deploymentName).toEqual(
        deployment.deploymentName,
      );
      expect(updated.deployment.outputs).toEqual({ greeting: "hello azure" });
      expect(updated.deployment.correlationId).not.toEqual(
        deployment.correlationId,
      );

      yield* stack.destroy();
      expect(
        yield* deploymentGone(
          group.resourceGroupName,
          deployment.deploymentName,
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 600_000,
  },
);
