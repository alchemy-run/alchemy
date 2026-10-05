import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
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

const getDefinition = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* solutions.GetApplicationDefinition({
      subscriptionId,
      resourceGroupName,
      applicationDefinitionName: name,
    });
  });

const definitionGone = (resourceGroupName: string, name: string) =>
  getDefinition(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["NotFound", "ResourceNotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
}) =>
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
        name: props.name,
        displayName: "Alchemy test definition",
        description: props.description,
        lockLevel: "None",
        authorizations: [
          { principalId: identity.principalId, roleDefinitionId: READER },
        ],
        mainTemplate,
        createUiDefinition,
        tags: props.tags,
      },
    );
    return { group, definition };
  });

test.provider(
  "create, update, replace, and delete a managed application definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ description: "first", tags: { env: "test" } }),
      );
      const rg = created.group.resourceGroupName;
      const name = created.definition.applicationDefinitionName;
      expect(created.definition.applicationDefinitionId).toContain(
        "/applicationDefinitions/",
      );
      expect(created.definition.lockLevel).toEqual("None");
      const observed = yield* getDefinition(rg, name);
      expect(observed.properties.description).toEqual("first");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Definition");

      // In-place update of description and tags.
      const updated = yield* stack.deploy(
        program({ description: "second", tags: { env: "prod" } }),
      );
      expect(updated.definition.applicationDefinitionName).toEqual(name);
      expect(updated.definition.description).toEqual("second");
      expect(updated.definition.tags).toEqual({ env: "prod" });
      const reobserved = yield* getDefinition(rg, name);
      expect(reobserved.properties.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("prod");

      // Renaming replaces the definition.
      const renamed = yield* stack.deploy(
        program({
          name: "alchemy-renamed-appdef",
          description: "second",
          tags: { env: "prod" },
        }),
      );
      expect(renamed.definition.applicationDefinitionName).toEqual(
        "alchemy-renamed-appdef",
      );
      expect(yield* definitionGone(rg, name)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* definitionGone(rg, "alchemy-renamed-appdef")).toEqual(
        "gone",
      );
    }),
  {
    timeout: 600_000,
    tags: ["provider:azure", "provider:azure:managedapplications", "live"],
  },
);
