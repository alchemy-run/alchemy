import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  connectedEnvironmentStack,
  MISSING_ENVIRONMENT,
  probeGroup,
} from "./fixtures/connected.ts";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:containerapps", "live"];

const getComponent = (
  resourceGroupName: string,
  connectedEnvironmentName: string,
  componentName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetConnectedEnvironmentsDaprComponent({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
      componentName,
    });
  });

const program = (props: {
  componentType: string;
  metadata: { name: string; value: string }[];
  scopes: string[];
}) =>
  Effect.gen(function* () {
    const { group, env } = yield* connectedEnvironmentStack;
    const component = yield* Azure.ContainerApps.ConnectedEnvironmentDaprComponent("Cron", {
      resourceGroup: group.resourceGroupName,
      environment: env.environmentName,
      componentType: props.componentType,
      metadata: props.metadata,
      scopes: props.scopes,
    });
    return { group, env, component };
  });

// ~cluster cost only, 20 min. Needs an Arc-enabled Kubernetes cluster with
// the Container Apps extension and a custom location (see
// fixtures/connected.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a connected environment Dapr component",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, env, component } = yield* stack.deploy(
        program({
          componentType: "bindings.cron",
          metadata: [{ name: "schedule", value: "@every 10m" }],
          scopes: ["worker"],
        }),
      );
      expect(component.componentType).toEqual("bindings.cron");
      expect(component.scopes).toEqual(["worker"]);
      const get = getComponent(
        group.resourceGroupName,
        env.environmentName,
        component.componentName,
      );
      const observed = yield* get;
      expect(observed.properties?.metadata?.[0]?.value).toEqual("@every 10m");

      // In-place update: metadata and scopes.
      const updated = yield* stack.deploy(
        program({
          componentType: "bindings.cron",
          metadata: [{ name: "schedule", value: "@every 20m" }],
          scopes: ["api"],
        }),
      );
      expect(updated.component.componentId).toEqual(component.componentId);
      const reobserved = yield* get;
      expect(reobserved.properties?.metadata?.[0]?.value).toEqual("@every 20m");
      expect(reobserved.properties?.scopes).toEqual(["api"]);

      // Replacement: a new component type recreates the component.
      const replaced = yield* stack.deploy(
        program({
          componentType: "bindings.localstorage",
          metadata: [{ name: "rootPath", value: "/tmp" }],
          scopes: ["api"],
        }),
      );
      expect(replaced.component.componentType).toEqual("bindings.localstorage");
      expect((yield* get).properties?.componentType).toEqual("bindings.localstorage");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe (free, a resource group only): a component under a missing
// connected environment is rejected with the typed error.
test.provider(
  "a missing connected environment rejects the Dapr component with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const error = yield* app
        .ConnectedEnvironmentsDaprComponentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          connectedEnvironmentName: MISSING_ENVIRONMENT,
          componentName: "probe",
          properties: {
            componentType: "bindings.cron",
            version: "v1",
            metadata: [{ name: "schedule", value: "@every 10m" }],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const component = yield* Azure.ContainerApps.ConnectedEnvironmentDaprComponent("Cron", {
              resourceGroup: probe.group.resourceGroupName,
              environment: MISSING_ENVIRONMENT,
              componentType: "bindings.cron",
              metadata: [{ name: "schedule", value: "@every 10m" }],
            });
            return { component };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
