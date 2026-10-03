import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as aci from "@distilled.cloud/azure/containerinstance";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getSandboxGroup = (resourceGroupName: string, sandboxGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* aci.GetSandboxGroup({
      subscriptionId,
      resourceGroupName,
      sandboxGroupName,
    });
  });

const sandboxGroupGone = (resourceGroupName: string, name: string) =>
  getSandboxGroup(resourceGroupName, name).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: { location?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const sandboxes = yield* Azure.ContainerInstance.SandboxGroup("Sandboxes", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
    });
    return { group, sandboxes };
  });

// Sandbox groups are a limited preview: ARM has not registered the
// `sandboxGroups` type on the trial subscription (not even listed by
// `GetProvider`), so the lifecycle only runs with AZURE_TEST_PAID=1 on a
// subscription with the preview. No compute until sandboxes start: ~$0.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a sandbox group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, sandboxes } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getSandboxGroup(
        group.resourceGroupName,
        sandboxes.sandboxGroupName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.sandboxes.sandboxGroupId).toEqual(
        sandboxes.sandboxGroupId,
      );
      const reobserved = yield* getSandboxGroup(
        group.resourceGroupName,
        sandboxes.sandboxGroupName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // A location change replaces the sandbox group.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "prod" } }),
      );
      expect(replaced.sandboxes.location.toLowerCase()).toEqual("westus2");
      expect(replaced.sandboxes.sandboxGroupName).not.toEqual(
        sandboxes.sandboxGroupName,
      );
      expect(
        yield* sandboxGroupGone(
          group.resourceGroupName,
          sandboxes.sandboxGroupName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* sandboxGroupGone(
          group.resourceGroupName,
          replaced.sandboxes.sandboxGroupName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 900_000,
  },
);

test.provider(
  "sandbox groups are rejected where the preview type is not rolled out",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("ProbeGroup", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const error = yield* aci
        .SandboxGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          sandboxGroupName: "alchemy-probe",
          location: "eastus",
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InvalidResourceType");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerinstance", "live"],
    timeout: 300_000,
  },
);
