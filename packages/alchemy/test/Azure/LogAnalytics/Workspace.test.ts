import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getWorkspace = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    });
  });

const workspaceGone = (resourceGroupName: string, workspaceName: string) =>
  getWorkspace(resourceGroupName, workspaceName).pipe(
    Effect.as("found" as const),
    // A deleted workspace answers 404 with an empty body (`NotFound`).
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  location?: string;
  retentionInDays: number;
  dailyQuotaGb?: number;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      retentionInDays: props.retentionInDays,
      dailyQuotaGb: props.dailyQuotaGb,
      tags: props.tags,
    });
    return { group, workspace };
  });

test.provider(
  "create, update, replace, and delete a Log Analytics workspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ retentionInDays: 30, tags: { env: "test" } }),
      );
      const rg = created.group.resourceGroupName;
      const first = created.workspace;
      expect(first.workspaceName).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$/);
      expect(first.customerId).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.skuName).toEqual("PerGB2018");
      expect(first.primarySharedKey).toBeDefined();
      expect(Redacted.value(first.primarySharedKey!).length).toBeGreaterThan(10);
      const observed = yield* getWorkspace(rg, first.workspaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.retentionInDays).toEqual(30);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Logs");

      // In-place update: retention, daily cap, and tags.
      const updated = yield* stack.deploy(
        program({ retentionInDays: 60, dailyQuotaGb: 1, tags: { env: "prod" } }),
      );
      expect(updated.workspace.workspaceName).toEqual(first.workspaceName);
      expect(updated.workspace.customerId).toEqual(first.customerId);
      const reobserved = yield* getWorkspace(rg, first.workspaceName);
      expect(reobserved.properties?.retentionInDays).toEqual(60);
      expect(reobserved.properties?.workspaceCapping?.dailyQuotaGb).toEqual(1);
      expect(reobserved.tags?.env).toEqual("prod");

      // Changing the location replaces the workspace.
      const moved = yield* stack.deploy(
        program({
          location: "westus2",
          retentionInDays: 60,
          dailyQuotaGb: 1,
          tags: { env: "prod" },
        }),
      );
      expect(moved.workspace.location.toLowerCase()).toEqual("westus2");
      expect(moved.workspace.customerId).not.toEqual(first.customerId);
      const replaced = yield* getWorkspace(rg, moved.workspace.workspaceName);
      expect(replaced.location.toLowerCase()).toEqual("westus2");
      if (moved.workspace.workspaceName !== first.workspaceName) {
        expect(yield* workspaceGone(rg, first.workspaceName)).toEqual("gone");
      }

      yield* stack.destroy();
      expect(yield* workspaceGone(rg, moved.workspace.workspaceName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
