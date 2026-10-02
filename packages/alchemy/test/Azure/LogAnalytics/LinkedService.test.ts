import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm.ts";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getLink = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* operationalinsights.GetLinkedService({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      linkedServiceName: "Automation",
    });
  });

const linkGone = (resourceGroupName: string, workspaceName: string) =>
  getLink(resourceGroupName, workspaceName).pipe(
    Effect.map((link) =>
      link.properties.provisioningState === "Deleting"
        ? ("gone" as const)
        : ("found" as const),
    ),
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

// Automation accounts are not an Alchemy resource yet; the test creates a
// free Basic account out of band and deletes it afterwards.
const AUTOMATION_ACCOUNT = "alchemy-loganalytics-link";

const createAutomationAccount = (resourceGroupName: string, location: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
    const account = yield* automation.AutomationAccountCreateOrUpdate({
      subscriptionId,
      resourceGroupName,
      automationAccountName: AUTOMATION_ACCOUNT,
      location,
      properties: { sku: { name: "Basic" } },
    });
    return account.id!;
  });

const deleteAutomationAccount = (resourceGroupName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    yield* automation
      .DeleteAutomationAccount({
        subscriptionId,
        resourceGroupName,
        automationAccountName: AUTOMATION_ACCOUNT,
      })
      .pipe(
        Effect.catchTag(
          ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
          () => Effect.void,
        ),
      );
  });

const program = (link?: { resourceId: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    // The Automation API caps resource group names at 80 characters.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      name: "alchemy-test-loganalytics-linkedservice",
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const linked = link
      ? yield* Azure.LogAnalytics.LinkedService("Automation", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
          name: "Automation",
          resourceId: link.resourceId,
          tags: link.tags,
        })
      : undefined;
    return { group, workspace, linked };
  });

test.provider(
  "create, update, and delete a linked Automation account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(program());
      const rg = base.group.resourceGroupName;
      const ws = base.workspace.workspaceName;
      const accountId = yield* createAutomationAccount(rg, "eastus");

      const created = yield* stack.deploy(
        program({ resourceId: accountId, tags: { env: "test" } }),
      );
      expect(created.linked!.linkedServiceName).toEqual("Automation");
      const observed = yield* getLink(rg, ws);
      expect(observed.properties.resourceId?.toLowerCase()).toEqual(
        accountId.toLowerCase(),
      );
      expect(observed.tags?.["alchemy::id"]).toEqual("Automation");

      // In-place tag update.
      yield* stack.deploy(
        program({ resourceId: accountId, tags: { env: "prod" } }),
      );
      expect((yield* getLink(rg, ws)).tags?.env).toEqual("prod");

      // Removing the link from the stack unlinks the account.
      yield* stack.deploy(program());
      expect(yield* linkGone(rg, ws)).toEqual("gone");

      yield* deleteAutomationAccount(rg);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:loganalytics", "live"],
    timeout: 900_000,
  },
);
