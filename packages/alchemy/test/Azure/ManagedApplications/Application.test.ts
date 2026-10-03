import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import * as solutions from "@distilled.cloud/azure/solutions";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  createUiDefinition,
  mainTemplate,
  READER,
} from "./fixtures/templates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApplication = (resourceGroupName: string, applicationName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* solutions.GetApplication({
      subscriptionId,
      resourceGroupName,
      applicationName,
    });
  });

const getGroup = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* resources.GetResourceGroup({
      subscriptionId,
      resourceGroupName,
    });
  });

const goneTags = [
  "NotFound",
  "ResourceNotFound",
  "ResourceGroupNotFound",
] as const;

const repeatUntilGone = {
  schedule: Schedule.spaced("5 seconds"),
  until: (status: "found" | "gone") => status === "gone",
  times: 24,
};

const applicationGone = (resourceGroupName: string, applicationName: string) =>
  getApplication(resourceGroupName, applicationName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(goneTags, () => Effect.succeed("gone" as const)),
    Effect.repeat(repeatUntilGone),
  );

const groupGone = (resourceGroupName: string) =>
  getGroup(resourceGroupName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(goneTags, () => Effect.succeed("gone" as const)),
    Effect.repeat(repeatUntilGone),
  );

const program = (props: { greeting: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Publisher",
      { resourceGroup: group.resourceGroupName },
    );
    const definition = yield* Azure.ManagedApplications.ApplicationDefinition(
      "Definition",
      {
        resourceGroup: group.resourceGroupName,
        displayName: "Alchemy test definition",
        description: "definition for the application test",
        authorizations: [
          { principalId: identity.principalId, roleDefinitionId: READER },
        ],
        mainTemplate,
        createUiDefinition,
      },
    );
    const app = yield* Azure.ManagedApplications.Application("App", {
      resourceGroup: group.resourceGroupName,
      applicationDefinitionId: definition.applicationDefinitionId,
      parameters: { greeting: props.greeting },
      tags: props.tags,
    });
    return { group, definition, app };
  });

// Free: the template deploys no resources; ~2-4 minutes end to end.
test.provider(
  "create, update, and delete a managed application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ greeting: "hello", tags: { env: "test" } }),
      );
      const rg = created.group.resourceGroupName;
      const app = created.app;
      expect(app.provisioningState).toEqual("Succeeded");
      expect(app.kind).toEqual("ServiceCatalog");
      expect(app.managedResourceGroupName).toEqual(
        `mrg-${app.applicationName}`,
      );
      expect(app.outputs.greeting).toEqual("hello");
      const observed = yield* getApplication(rg, app.applicationName);
      expect(observed.tags?.env).toEqual("test");
      expect(
        observed.properties.applicationDefinitionId?.toLowerCase(),
      ).toEqual(created.definition.applicationDefinitionId.toLowerCase());
      const managed = yield* getGroup(app.managedResourceGroupName);
      expect(managed.name?.toLowerCase()).toEqual(
        app.managedResourceGroupName.toLowerCase(),
      );

      // In-place update of a template parameter and tags.
      const updated = yield* stack.deploy(
        program({ greeting: "goodbye", tags: { env: "prod" } }),
      );
      expect(updated.app.applicationName).toEqual(app.applicationName);
      expect(updated.app.tags).toEqual({ env: "prod" });
      expect(updated.app.outputs.greeting).toEqual("goodbye");
      const reobserved = yield* getApplication(rg, app.applicationName);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* applicationGone(rg, app.applicationName)).toEqual("gone");
      expect(yield* groupGone(app.managedResourceGroupName)).toEqual("gone");
    }),
  {
    timeout: 900_000,
    tags: ["provider:azure", "provider:azure:managedapplications", "live"],
  },
);
