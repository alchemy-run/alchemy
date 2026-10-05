import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Resource group + Log Analytics workspace + Sentinel onboarding. */
export const sentinelWorkspace = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const logs = yield* Azure.LogAnalytics.Workspace("Logs", {
    resourceGroup: group.resourceGroupName,
  });
  const sentinel = yield* Azure.SecurityInsights.OnboardingState("Sentinel", {
    resourceGroup: group.resourceGroupName,
    workspace: logs.workspaceName,
  });
  return { group, logs, sentinel };
});

/**
 * Poll an out-of-band probe (`"found"` / `"gone"`, not-found mapped to
 * `"gone"` by the caller with `catchTag`) until it reports gone (~60s).
 */
export const pollGone = <E, R>(
  probe: Effect.Effect<"found" | "gone", E, R>,
) =>
  probe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

export const tags = [
  "provider:azure",
  "provider:azure:securityinsights",
  "live",
];
