import * as Azure from "@alchemy.run/azure";
import * as msi from "@distilled.cloud/azure/msi";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import type { DeleteFailure } from "alchemy/Apply";
import * as Test from "alchemy/Test/Alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const tags = ["provider:azure", "provider:azure:resources", "live"];

const getGroup = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* resources
      .GetResourceGroup({ subscriptionId, resourceGroupName })
      .pipe(Effect.catchTag("ResourceGroupNotFound", () => Effect.succeed(undefined)));
  });

const waitUntilGone = (resourceGroupName: string) =>
  getGroup(resourceGroupName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (group) => group === undefined,
      times: 36,
    }),
  );

const deleteGroup = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* resources
      .DeleteResourceGroup({ subscriptionId, resourceGroupName })
      .pipe(Effect.catchTag("ResourceGroupNotFound", () => Effect.void));
    yield* waitUntilGone(resourceGroupName);
  });

const getIdentity = (resourceGroupName: string, resourceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* msi
      .GetUserAssignedIdentity({ subscriptionId, resourceGroupName, resourceName })
      .pipe(
        Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
          Effect.succeed(undefined),
        ),
      );
  });

test.provider(
  "resources without a resourceGroup go into the stack's <stack>-<stage> group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const expected = Azure.defaultResourceGroupName(stack.name, stack.stage);

      const identity = yield* stack.deploy(Azure.ManagedIdentity.UserAssignedIdentity("Identity"));
      expect(identity.resourceGroup).toEqual(expected);

      const group = yield* getGroup(expected);
      expect(group?.properties?.provisioningState).toEqual("Succeeded");
      expect(group?.tags?.["alchemy::id"]).toEqual(Azure.DEFAULT_RESOURCE_GROUP_ID);
      expect(group?.tags?.["alchemy::stack"]).toEqual(stack.name);
      expect(group?.tags?.["alchemy::stage"]).toEqual(stack.stage);
      const observedIdentity = yield* getIdentity(expected, identity.identityName);
      expect(observedIdentity?.name).toEqual(identity.identityName);

      // An identity Alchemy did not create keeps destroy from deleting the group.
      const { subscriptionId, location } = yield* Azure.AzureEnvironment.current;
      const foreign = "alchemy-test-foreign-identity";
      yield* msi.UserAssignedIdentitiesCreateOrUpdate({
        subscriptionId,
        resourceGroupName: expected,
        resourceName: foreign,
        location,
      });

      const error = yield* stack.destroy().pipe(Effect.flip);
      expect(error._tag).toEqual("DestroyError");
      const failure = error.failures.find(
        (f: DeleteFailure) => f.logicalId === Azure.DEFAULT_RESOURCE_GROUP_ID,
      );
      const cause = Option.getOrUndefined(Cause.findErrorOption(failure!.cause));
      expect(cause).toBeInstanceOf(Azure.Resources.ResourceGroupNotEmpty);
      const deletedIdentity = yield* getIdentity(expected, identity.identityName);
      expect(deletedIdentity).toBeUndefined();
      const keptGroup = yield* getGroup(expected);
      expect(keptGroup?.name).toEqual(expected);

      // Once the foreign identity is gone, destroy deletes the empty group.
      yield* msi.DeleteUserAssignedIdentity({
        subscriptionId,
        resourceGroupName: expected,
        resourceName: foreign,
      });
      yield* stack.destroy();
      const goneGroup = yield* waitUntilGone(expected);
      expect(goneGroup).toBeUndefined();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider(
  "Azure.resourceGroup(name) deploys into an existing group and never deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subscriptionId, location } = yield* Azure.AzureEnvironment.current;
      const existing = `alchemy-test-existing-rg-${stack.stage}`;
      yield* resources.ResourceGroupsCreateOrUpdate({
        subscriptionId,
        resourceGroupName: existing,
        location,
      });

      const identity = yield* stack.deploy(
        Azure.ManagedIdentity.UserAssignedIdentity("Identity").pipe(
          Effect.provide(Azure.resourceGroup(existing)),
        ),
      );
      expect(identity.resourceGroup).toEqual(existing);
      const observedIdentity = yield* getIdentity(existing, identity.identityName);
      expect(observedIdentity?.name).toEqual(identity.identityName);
      const defaultGroup = yield* getGroup(Azure.defaultResourceGroupName(stack.name, stack.stage));
      expect(defaultGroup).toBeUndefined();

      yield* stack.destroy();
      const deletedIdentity = yield* getIdentity(existing, identity.identityName);
      expect(deletedIdentity).toBeUndefined();
      const keptGroup = yield* getGroup(existing);
      expect(keptGroup?.name).toEqual(existing);

      yield* deleteGroup(existing);
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

test.provider(
  "Azure.resourceGroup(group) puts resources into a declared group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("App", {
            tags: { team: "shop" },
          });
          const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("Identity").pipe(
            Effect.provide(Azure.resourceGroup(group)),
          );
          return { group, identity };
        }),
      );
      expect(identity.resourceGroup).toEqual(group.resourceGroupName);
      const observedIdentity = yield* getIdentity(group.resourceGroupName, identity.identityName);
      expect(observedIdentity?.name).toEqual(identity.identityName);
      const defaultGroup = yield* getGroup(Azure.defaultResourceGroupName(stack.name, stack.stage));
      expect(defaultGroup).toBeUndefined();

      yield* stack.destroy();
      const goneGroup = yield* waitUntilGone(group.resourceGroupName);
      expect(goneGroup).toBeUndefined();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
