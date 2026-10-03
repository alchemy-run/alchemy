import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const LOCATION = "eastus";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (resourceGroupName: string, sandboxGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetSandboxGroup({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const sandboxes = yield* Azure.ContainerApps.SandboxGroup("Sandboxes", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      name: props.name,
      tags: props.tags,
    });
    return { group, sandboxes };
  });

// Cost: an empty sandbox group is free (~$0); provisions in seconds.
test.provider(
  "create, update, replace, and delete a sandbox group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, sandboxes } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(sandboxes.managementEndpoint).toContain("azuredevcompute.io");
      expect(sandboxes.tags).toEqual({ env: "test" });
      const observed = yield* getGroup(
        group.resourceGroupName,
        sandboxes.sandboxGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Sandboxes");

      // In-place update: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.sandboxes.sandboxGroupId).toEqual(
        sandboxes.sandboxGroupId,
      );
      expect(
        (yield* getGroup(group.resourceGroupName, sandboxes.sandboxGroupName))
          .tags?.env,
      ).toEqual("prod");

      // Replacement: a new name recreates the group.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-sandbox-two", tags: { env: "prod" } }),
      );
      expect(replaced.sandboxes.sandboxGroupName).toEqual(
        "alchemy-sandbox-two",
      );
      expect(
        yield* waitGone(
          getGroup(group.resourceGroupName, sandboxes.sandboxGroupName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getGroup(group.resourceGroupName, "alchemy-sandbox-two"),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerapps", "live"],
    timeout: 900_000,
  },
);
