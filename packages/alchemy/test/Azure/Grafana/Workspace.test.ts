import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dashboard from "@distilled.cloud/azure/dashboard";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* dashboard.GetGrafana({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
  });

const workspaceGone = (resourceGroupName: string, workspaceName: string) =>
  getWorkspace(resourceGroupName, workspaceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = (props: {
  apiKey: Azure.Grafana.GrafanaToggle;
  zoneRedundancy?: Azure.Grafana.GrafanaToggle;
  viewersCanEdit: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.Grafana.Workspace("Grafana", {
      resourceGroup: group.resourceGroupName,
      identity: { type: "SystemAssigned" },
      apiKey: props.apiKey,
      zoneRedundancy: props.zoneRedundancy,
      grafanaConfigurations: { users: { viewersCanEdit: props.viewersCanEdit } },
      tags: props.tags,
    });
    return { group, workspace };
  });

// Standard X1 bills ~$0.07/hour (the first workspace in a subscription is
// free for 30 days): cents per run, but ~3 min create, ~30 s update, and
// 8-12 min delete — ~13-15 min end to end, over the time budget.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Grafana workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({
          apiKey: "Disabled",
          viewersCanEdit: false,
          tags: { env: "test" },
        }),
      );
      expect(workspace.workspaceName).toMatch(/^[a-z][a-z0-9-]{1,22}$/);
      expect(workspace.sku).toEqual("Standard");
      expect(workspace.endpoint).toContain("grafana.azure.com");
      expect(workspace.principalId).toBeDefined();
      const observed = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.apiKey).toEqual("Disabled");
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Grafana");

      // In-place updates: API keys, Grafana configuration, and tags.
      const updated = yield* stack.deploy(
        program({
          apiKey: "Enabled",
          viewersCanEdit: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.workspace.workspaceName).toEqual(workspace.workspaceName);
      expect(updated.workspace.endpoint).toEqual(workspace.endpoint);
      const reobserved = yield* getWorkspace(
        group.resourceGroupName,
        workspace.workspaceName,
      );
      expect(reobserved.properties?.apiKey).toEqual("Enabled");
      expect(
        reobserved.properties?.grafanaConfigurations?.users?.viewersCanEdit,
      ).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* workspaceGone(group.resourceGroupName, workspace.workspaceName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:grafana", "live"],
    timeout: 2_400_000,
  },
);

// Replacement provisions a second (zone-redundant, pricier) workspace and
// deletes two: ~25 min end to end, under $1 but slow.
test.provider.skipIf(!runExpensive)(
  "replace a Grafana workspace when zone redundancy changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace } = yield* stack.deploy(
        program({ apiKey: "Disabled", viewersCanEdit: false, tags: {} }),
      );
      const replaced = yield* stack.deploy(
        program({
          apiKey: "Disabled",
          zoneRedundancy: "Enabled",
          viewersCanEdit: false,
          tags: {},
        }),
      );
      expect(replaced.workspace.workspaceName).not.toEqual(
        workspace.workspaceName,
      );
      expect(replaced.workspace.zoneRedundancy).toEqual("Enabled");
      expect(
        yield* workspaceGone(group.resourceGroupName, workspace.workspaceName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* workspaceGone(
          group.resourceGroupName,
          replaced.workspace.workspaceName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:grafana", "live"],
    timeout: 2_400_000,
  },
);
