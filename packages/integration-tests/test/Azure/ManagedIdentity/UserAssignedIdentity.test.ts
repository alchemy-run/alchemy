import * as Azure from "@alchemy.run/azure";
import * as msi from "@distilled.cloud/azure/msi";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getIdentity = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* msi.GetUserAssignedIdentity({
      subscriptionId,
      resourceGroupName,
      resourceName,
    });
  });

const identityGone = (resourceGroupName: string, resourceName: string) =>
  getIdentity(resourceGroupName, resourceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: { name?: string; tags?: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Identity", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, identity };
  });

test.provider(
  "create, update tags, rename, and delete a user-assigned identity",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create with a generated name.
      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const rg = created.group.resourceGroupName;
      const identity = created.identity;
      expect(identity.identityName).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/);
      expect(identity.location).toEqual("eastus");
      expect(identity.tags).toEqual({ env: "test" });
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      expect(identity.identityId.toLowerCase()).toEqual(
        `/subscriptions/${subscriptionId}/resourcegroups/${rg}/providers/microsoft.managedidentity/userassignedidentities/${identity.identityName}`.toLowerCase(),
      );
      expect(identity.principalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.clientId).toMatch(/^[0-9a-f-]{36}$/);
      expect(identity.tenantId).toMatch(/^[0-9a-f-]{36}$/);

      const observed = yield* getIdentity(rg, identity.identityName);
      expect(observed.properties?.principalId).toEqual(identity.principalId);
      expect(observed.properties?.clientId).toEqual(identity.clientId);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Identity");

      // Tags update in place: the identity (and its principal) is kept.
      const updated = yield* stack.deploy(program({ tags: { env: "prod", team: "api" } }));
      expect(updated.identity.identityName).toEqual(identity.identityName);
      expect(updated.identity.principalId).toEqual(identity.principalId);
      expect(updated.identity.tags).toEqual({ env: "prod", team: "api" });
      const reobserved = yield* getIdentity(rg, identity.identityName);
      expect(reobserved.properties?.principalId).toEqual(identity.principalId);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("api");

      // Renaming replaces the identity: a new principal, the old one deleted.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-test-uai-renamed", tags: { env: "prod" } }),
      );
      expect(renamed.identity.identityName).toEqual("alchemy-test-uai-renamed");
      expect(renamed.identity.principalId).not.toEqual(identity.principalId);
      const replacement = yield* getIdentity(rg, "alchemy-test-uai-renamed");
      expect(replacement.properties?.principalId).toEqual(renamed.identity.principalId);
      expect(yield* identityGone(rg, identity.identityName)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* identityGone(rg, "alchemy-test-uai-renamed")).toEqual("gone");
    }),
  {
    tags: ["provider:azure", "provider:azure:managedidentity", "live"],
    timeout: 600_000,
  },
);
