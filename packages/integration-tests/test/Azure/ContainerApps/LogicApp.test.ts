import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  arcLocation,
  connectedEnvironmentStack,
  customLocationId,
  probeGroup,
} from "./fixtures/connected.ts";
import { logLevel, waitGone } from "./fixtures/shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:containerapps", "live"];

/** Logic Apps Standard runtime image for the `workflowapp` host. */
const LOGIC_APPS_IMAGE =
  process.env.AZURE_TEST_CONTAINERAPPS_LOGICAPPS_IMAGE ?? "default/logicapps-base:latest";

/** Name of a container app that does not exist (probes). */
const MISSING_APP = "alchemy-missing-app";

const getLogicApp = (resourceGroupName: string, containerAppName: string, logicAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetLogicApp({
      subscriptionId,
      resourceGroupName,
      containerAppName,
      logicAppName,
    });
  });

const program = (props: { withLogicApp: boolean }) =>
  Effect.gen(function* () {
    const { group, env } = yield* connectedEnvironmentStack;
    const host = yield* Azure.ContainerApps.ContainerApp("Workflows", {
      resourceGroup: group.resourceGroupName,
      location: arcLocation(),
      environmentId: env.environmentId,
      customLocationId: customLocationId(),
      kind: "workflowapp",
      configuration: { ingress: { external: true, targetPort: 80 } },
      template: {
        containers: [
          {
            name: "logicapps",
            image: LOGIC_APPS_IMAGE,
            resources: { cpu: 1, memory: "2Gi" },
          },
        ],
        scale: { minReplicas: 1, maxReplicas: 1 },
      },
    });
    const logicApp = props.withLogicApp
      ? yield* Azure.ContainerApps.LogicApp("Logic", {
          resourceGroup: group.resourceGroupName,
          containerApp: host.containerAppName,
        })
      : undefined;
    return { group, env, host, logicApp };
  });

// ~cluster cost only, 25 min. Logic Apps on Container Apps is the Logic
// Apps Standard hybrid deployment: it needs an Arc-enabled Kubernetes
// cluster with the Container Apps extension and a custom location (see
// fixtures/connected.ts).
test.provider.skipIf(!runPaidOnly)(
  "create and delete a Logic App extension on a workflow container app",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, host, logicApp } = yield* stack.deploy(program({ withLogicApp: true }));
      expect(logicApp?.logicAppName).toEqual(host.containerAppName);
      const get = getLogicApp(
        group.resourceGroupName,
        host.containerAppName,
        host.containerAppName,
      );
      expect((yield* get).id?.toLowerCase()).toEqual(logicApp?.logicAppId.toLowerCase());

      // Redeploy is a no-op that keeps the same extension.
      const again = yield* stack.deploy(program({ withLogicApp: true }));
      expect(again.logicApp?.logicAppId).toEqual(logicApp?.logicAppId);

      // Remove the extension while the container app stays.
      yield* stack.deploy(program({ withLogicApp: false }));
      expect(yield* waitGone(get)).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);

// Ungated probe (free, a resource group only): a Logic App on a missing
// container app is rejected with the typed error.
test.provider(
  "a missing container app rejects the Logic App with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const error = yield* app
        .LogicAppsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          containerAppName: MISSING_APP,
          logicAppName: MISSING_APP,
          properties: {},
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const logicApp = yield* Azure.ContainerApps.LogicApp("Logic", {
              resourceGroup: probe.group.resourceGroupName,
              containerApp: MISSING_APP,
            });
            return { logicApp };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
