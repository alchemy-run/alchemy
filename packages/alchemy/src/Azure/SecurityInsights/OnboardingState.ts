import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
} from "./Common.ts";

/** The onboarding state is a singleton per workspace. */
const NAME = "default";

export interface OnboardingStateProps {
  /** Resource group of the Log Analytics workspace. Changing it replaces the onboarding. */
  resourceGroup: string;
  /** Log Analytics workspace to enable Microsoft Sentinel on. Changing it replaces the onboarding. */
  workspace: string;
  /**
   * Whether the workspace uses a customer-managed key for Sentinel data.
   * It cannot be toggled after onboarding; changing it replaces the
   * onboarding (offboards and re-onboards Sentinel).
   * @default false
   */
  customerManagedKey?: boolean;
}

export interface OnboardingState extends Resource<
  "Azure.SecurityInsights.OnboardingState",
  OnboardingStateProps,
  {
    /** ARM resource ID of the onboarding state. */
    onboardingStateId: string;
    /** Name of the onboarding state (always `default`). */
    name: string;
    /** Log Analytics workspace Sentinel is enabled on. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Whether the workspace uses a customer-managed key. */
    customerManagedKey: boolean;
    /** ETag of the onboarding state. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables Microsoft Sentinel on a Log Analytics workspace. Every other
 * `SecurityInsights` resource lives in an onboarded workspace: pass this
 * resource's `workspace` attribute to them so they are created after the
 * onboarding and deleted before it.
 *
 * Deleting the onboarding state offboards Sentinel from the workspace.
 *
 * @see https://learn.microsoft.com/azure/sentinel/quickstart-onboard
 *
 * ### Enabling Microsoft Sentinel
 * **Example:** Onboard a workspace
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 * });
 * ```
 *
 * **Example:** Depend on the onboarding from Sentinel content
 * ```typescript
 * const rule = yield* Azure.SecurityInsights.AutomationRule("triage", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Raise severity",
 *   order: 1,
 *   triggeringLogic: { isEnabled: true, triggersOn: "Incidents", triggersWhen: "Created" },
 *   actions: [
 *     { order: 1, actionType: "ModifyProperties", actionConfiguration: { severity: "High" } },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const OnboardingState = Resource<OnboardingState>(
  "Azure.SecurityInsights.OnboardingState",
);

const getState = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetSentinelOnboardingState({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      sentinelOnboardingStateName: NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  state: securityinsights.GetSentinelOnboardingStateResponse,
): OnboardingState["Attributes"] => ({
  onboardingStateId: state.id ?? "",
  name: state.name ?? NAME,
  workspace,
  resourceGroup,
  customerManagedKey: state.properties?.customerManagedKey ?? false,
  etag: state.etag,
});

export const OnboardingStateProvider = () =>
  Provider.succeed(OnboardingState, {
    stables: ["onboardingStateId", "name", "workspace", "resourceGroup"],

    // Onboarding lives inside a workspace; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.customerManagedKey ?? false) !== output.customerManagedKey
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const observed = yield* getState(subscriptionId, resourceGroup, workspace);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, observed);
      // No tags or free text: ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      // Onboarding installs the SecurityInsights solution through this RP.
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationsManagement");
      const { resourceGroup, workspace } = news;

      // Observe; ensure. Existence-only: the CMK flag is immutable.
      let observed = yield* getState(subscriptionId, resourceGroup, workspace);
      if (observed === undefined) {
        observed = yield* securityinsights.CreateSentinelOnboardingState({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          sentinelOnboardingStateName: NAME,
          properties: { customerManagedKey: news.customerManagedKey ?? false },
        });
      }
      return toAttrs(resourceGroup, workspace, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteSentinelOnboardingState({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          sentinelOnboardingStateName: NAME,
        }),
      );
      yield* waitUntilGone(
        `Sentinel onboarding of ${output.workspace}`,
        getState(subscriptionId, output.resourceGroup, output.workspace),
      );
    }),
  });
