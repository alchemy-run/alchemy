import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as msi from "@distilled.cloud/azure/msi";
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

const IDENTITY = "alchemy-stack-test-identity";

const template = (withIdentity: boolean) => ({
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: { label: { type: "string" } },
  resources: withIdentity
    ? [
        {
          type: "Microsoft.ManagedIdentity/userAssignedIdentities",
          apiVersion: "2023-01-31",
          name: IDENTITY,
          location: "[resourceGroup().location]",
        },
      ]
    : [],
  outputs: {
    label: { type: "string", value: "[parameters('label')]" },
  },
});

const getStack = (resourceGroupName: string, deploymentStackName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetDeploymentStackAtResourceGroup({
        subscriptionId,
        resourceGroupName,
        deploymentStackName,
      }),
    );
  });

const getIdentity = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      msi.GetUserAssignedIdentity({
        subscriptionId,
        resourceGroupName,
        resourceName: IDENTITY,
      }),
    );
  });

const untilGone = <A, E, R>(get: Effect.Effect<A | undefined, E, R>) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (observed) => observed === undefined,
      times: 36,
    }),
  );

const program = (props: {
  withIdentity: boolean;
  label: string;
  description: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const stack = yield* Azure.Resources.DeploymentStack("Stack", {
      resourceGroup: group.resourceGroupName,
      template: template(props.withIdentity),
      parameters: { label: props.label },
      description: props.description,
      tags: { purpose: "test" },
    });
    return { group, stack };
  });

test.provider(
  "create a deployment stack, update it in place, delete unmanaged resources, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, stack: created } = yield* stack.deploy(
        program({ withIdentity: true, label: "one", description: "first" }),
      );
      expect(created.provisioningState).toEqual("succeeded");
      expect(created.outputs).toEqual({ label: "one" });
      expect(
        created.managedResources.some((id) =>
          id.toLowerCase().endsWith(`/${IDENTITY}`),
        ),
      ).toBe(true);
      expect(created.tags).toEqual({ purpose: "test" });
      const observed = yield* getStack(
        group.resourceGroupName,
        created.deploymentStackName,
      );
      expect(observed?.tags?.["alchemy::id"]).toEqual("Stack");
      expect(observed?.properties?.description).toEqual("first");
      expect(yield* getIdentity(group.resourceGroupName)).toBeDefined();

      // Unchanged inputs do not redeploy.
      const again = yield* stack.deploy(
        program({ withIdentity: true, label: "one", description: "first" }),
      );
      expect(again.stack.correlationId).toEqual(created.correlationId);

      // Dropping the identity from the template deletes it (actionOnUnmanage).
      const updated = yield* stack.deploy(
        program({ withIdentity: false, label: "two", description: "second" }),
      );
      expect(updated.stack.deploymentStackName).toEqual(
        created.deploymentStackName,
      );
      expect(updated.stack.outputs).toEqual({ label: "two" });
      expect(updated.stack.managedResources).toEqual([]);
      expect(
        (yield* getStack(group.resourceGroupName, created.deploymentStackName))
          ?.properties?.description,
      ).toEqual("second");
      expect(
        yield* untilGone(getIdentity(group.resourceGroupName)),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getStack(group.resourceGroupName, created.deploymentStackName),
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 900_000,
  },
);
