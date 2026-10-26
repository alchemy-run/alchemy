import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  arcLocation,
  customLocationId,
  missingCustomLocationId,
  probeGroup,
} from "./fixtures/connected.ts";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:containerapps", "live"];

const getEnvironment = (resourceGroupName: string, connectedEnvironmentName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetConnectedEnvironment({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: arcLocation,
    });
    const env = yield* Azure.ContainerApps.ConnectedEnvironment("ArcEnv", {
      resourceGroup: group.resourceGroupName,
      location: arcLocation,
      customLocationId: customLocationId(),
      name: props.name,
      tags: props.tags,
    });
    return { group, env };
  });

// ~cluster cost only, 15 min. Needs an Arc-enabled Kubernetes cluster with
// the Container Apps extension and a custom location (see
// fixtures/connected.ts); the testing subscription has none.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a connected environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env } = yield* stack.deploy(program({ tags: { env: "test" } }));
      expect(env.environmentName).toMatch(/^[a-z][a-z0-9-]{1,59}$/);
      expect(env.customLocationId?.toLowerCase()).toEqual(customLocationId().toLowerCase());
      const get = (name: string) => getEnvironment(group.resourceGroupName, name);
      const observed = yield* get(env.environmentName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("ArcEnv");

      // In-place update: tags (PATCH).
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.env.environmentId).toEqual(env.environmentId);
      expect((yield* get(env.environmentName)).tags?.env).toEqual("prod");

      // Replacement: a new name creates a new environment.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-arc-env-two", tags: { env: "prod" } }),
      );
      expect(replaced.env.environmentName).toEqual("alchemy-arc-env-two");
      expect(yield* waitGone(get(env.environmentName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-arc-env-two"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe (free, a resource group only): without an Arc custom
// location the PUT is rejected with the typed error.
test.provider(
  "a missing custom location rejects the connected environment with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const missing = missingCustomLocationId(subscriptionId, group.resourceGroupName);
      const error = yield* app
        .ConnectedEnvironmentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          connectedEnvironmentName: "alchemy-probe",
          location: "eastus",
          extendedLocation: { name: missing, type: "CustomLocation" },
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      const getError = yield* getEnvironment(group.resourceGroupName, "alchemy-probe").pipe(
        Effect.flip,
      );
      expect(getError._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const env = yield* Azure.ContainerApps.ConnectedEnvironment("ArcEnv", {
              resourceGroup: probe.group.resourceGroupName,
              location: "eastus",
              customLocationId: missing,
            });
            return { env };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("CustomLocationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
