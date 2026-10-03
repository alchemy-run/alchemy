import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getState = (resourceGroupName: string, workspaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* securityinsights.GetSentinelOnboardingState({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      sentinelOnboardingStateName: "default",
    });
  });

const stateGone = (resourceGroupName: string, workspaceName: string) =>
  getState(resourceGroupName, workspaceName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (onboard: boolean) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const workspace = yield* Azure.LogAnalytics.Workspace("Logs", {
      resourceGroup: group.resourceGroupName,
    });
    const sentinel = onboard
      ? yield* Azure.SecurityInsights.OnboardingState("Sentinel", {
          resourceGroup: group.resourceGroupName,
          workspace: workspace.workspaceName,
        })
      : undefined;
    return { group, workspace, sentinel };
  });

// Sentinel's 31-day free trial covers an empty workspace: ~$0 per run.
test.provider(
  "onboard and offboard Microsoft Sentinel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(true));
      const rg = created.group.resourceGroupName;
      const ws = created.workspace.workspaceName;
      expect(created.sentinel!.name).toEqual("default");
      expect(created.sentinel!.customerManagedKey).toEqual(false);
      const observed = yield* getState(rg, ws);
      expect(observed.id?.toLowerCase()).toContain(
        "/providers/microsoft.securityinsights/onboardingstates/default",
      );

      // A no-op redeploy keeps the onboarding.
      const again = yield* stack.deploy(program(true));
      expect(again.sentinel!.onboardingStateId).toEqual(
        created.sentinel!.onboardingStateId,
      );

      // Removing the resource offboards Sentinel but keeps the workspace.
      yield* stack.deploy(program(false));
      expect(yield* stateGone(rg, ws)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:securityinsights", "live"],
    timeout: 900_000,
  },
);
