import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createSiteRecoveryName,
  ownedOrUnowned,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/** A script, runbook, or manual step run before or after a group. */
export interface RecoveryPlanGroupAction {
  /** Action name. */
  actionName: string;
  /** Failover types the action runs for, e.g. `["PlannedFailover", "TestFailover"]`. */
  failoverTypes: string[];
  /** Failover directions the action runs for, e.g. `["PrimaryToRecovery"]`. */
  failoverDirections: ("PrimaryToRecovery" | "RecoveryToPrimary")[];
  /**
   * Action details, polymorphic on `instanceType`: `ManualActionDetails`
   * (`description`), `ScriptActionDetails` (`path`, `fabricLocation`),
   * `AutomationRunbookActionDetails` (`runbookId`, `fabricLocation`).
   */
  customDetails: { instanceType: string; [key: string]: unknown };
}

/** An ordered failover group of the plan. */
export interface RecoveryPlanGroup {
  /** Group kind: `Shutdown`, `Failover`, or `Boot` (boot groups run in order). */
  groupType: "Shutdown" | "Boot" | "Failover";
  /** Protected items in the group (ARM IDs of replication protected items). */
  replicationProtectedItems?: {
    /** ARM ID of the replication protected item. */
    id?: string;
    /** ARM ID of the protected virtual machine. */
    virtualMachineId?: string;
  }[];
  /** Actions run before the group. */
  startGroupActions?: RecoveryPlanGroupAction[];
  /** Actions run after the group. */
  endGroupActions?: RecoveryPlanGroupAction[];
}

export interface RecoveryPlanProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the plan. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the plan. */
  vault: string;
  /**
   * Plan name, unique within the vault. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * plan.
   */
  name?: string;
  /** ARM ID of the primary fabric. Changing it replaces the plan. */
  primaryFabricId: string;
  /** ARM ID of the recovery fabric. Changing it replaces the plan. */
  recoveryFabricId: string;
  /**
   * Failover deployment model. Changing it replaces the plan.
   * @default "ResourceManager"
   */
  failoverDeploymentModel?: "NotApplicable" | "Classic" | "ResourceManager";
  /**
   * Ordered failover groups. A plan has the `Shutdown` and `Failover`
   * groups plus at least one `Boot` group. Updated in place.
   */
  groups: RecoveryPlanGroup[];
  /**
   * Provider-specific inputs, e.g. `[{ instanceType: "A2A",
   * primaryZone, recoveryZone }]`. Changing them replaces the plan.
   */
  providerSpecificInput?: { instanceType: string; [key: string]: unknown }[];
}

export interface RecoveryPlan extends Resource<
  "Azure.SiteRecovery.RecoveryPlan",
  RecoveryPlanProps,
  {
    /** Name of the plan. */
    recoveryPlanName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the plan. */
    recoveryPlanId: string;
    /** ARM ID of the primary fabric. */
    primaryFabricId: string;
    /** ARM ID of the recovery fabric. */
    recoveryFabricId: string;
    /** Failover deployment model. */
    failoverDeploymentModel: string | undefined;
    /** Replication providers of the items in the plan. */
    replicationProviders: string[];
    /** Groups as observed in Azure. */
    groups: RecoveryPlanGroup[];
  },
  never,
  Providers
> {}

/**
 * An Azure Site Recovery recovery plan: ordered failover groups of
 * replication protected items, with optional scripts, runbooks, or manual
 * steps before and after each group.
 *
 * Plans cannot be tagged; Alchemy treats a plan as owned when its vault is
 * tagged for the current stack and stage. Groups are updated in place; the
 * fabrics and deployment model are immutable. A plan's boot groups
 * reference protected items, so it is usually created after
 * {@link ProtectedItem}.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-recovery-plans/create
 *
 * ### Azure-to-Azure Disaster Recovery
 * **Example:** One boot group with a protected VM
 * ```typescript
 * yield* Azure.SiteRecovery.RecoveryPlan("dr-plan", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   primaryFabricId: primary.fabricId,
 *   recoveryFabricId: recovery.fabricId,
 *   groups: [
 *     { groupType: "Boot", replicationProtectedItems: [{ id: item.protectedItemId }] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RecoveryPlan = Resource<RecoveryPlan>(
  "Azure.SiteRecovery.RecoveryPlan",
);

type Observed = asr.GetReplicationRecoveryPlanResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  recoveryPlanName: string;
}

const getPlan = (where: Where) =>
  orUndefinedIfNotFound(asr.GetReplicationRecoveryPlan(where));

/** Comparable fingerprint of groups: types, item IDs, and action names. */
const groupsKey = (
  groups: readonly {
    groupType?: string;
    replicationProtectedItems?: readonly { id?: string }[];
    startGroupActions?: readonly { actionName?: string }[];
    endGroupActions?: readonly { actionName?: string }[];
  }[],
) =>
  JSON.stringify(
    groups.map((g) => [
      (g.groupType ?? "").toLowerCase(),
      (g.replicationProtectedItems ?? [])
        .map((i) => (i.id ?? "").toLowerCase())
        .sort(),
      (g.startGroupActions ?? []).map((a) => a.actionName),
      (g.endGroupActions ?? []).map((a) => a.actionName),
    ]),
  );

/** ASR always keeps the Shutdown and Failover groups; compare user-visible ones. */
const withImplicitGroups = (groups: readonly RecoveryPlanGroup[]) => {
  const hasShutdown = groups.some((g) => g.groupType === "Shutdown");
  const hasFailover = groups.some((g) => g.groupType === "Failover");
  return [
    ...(hasShutdown ? [] : [{ groupType: "Shutdown" as const }]),
    ...(hasFailover ? [] : [{ groupType: "Failover" as const }]),
    ...groups,
  ];
};

const observedGroups = (observed: Observed) =>
  (observed.properties?.groups ?? []) as unknown as RecoveryPlanGroup[];

const toAttrs = (
  where: Where,
  observed: Observed,
): RecoveryPlan["Attributes"] => ({
  recoveryPlanName: where.recoveryPlanName,
  vault: where.resourceName,
  resourceGroup: where.resourceGroupName,
  recoveryPlanId: observed.id ?? "",
  primaryFabricId: observed.properties?.primaryFabricId ?? "",
  recoveryFabricId: observed.properties?.recoveryFabricId ?? "",
  failoverDeploymentModel: observed.properties?.failoverDeploymentModel,
  replicationProviders: [...(observed.properties?.replicationProviders ?? [])],
  groups: observedGroups(observed),
});

export const RecoveryPlanProvider = () =>
  Provider.succeed(RecoveryPlan, {
    stables: ["recoveryPlanName", "vault", "resourceGroup", "recoveryPlanId"],

    // Plans live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        (news.name !== undefined &&
          !sameName(news.name, output.recoveryPlanName)) ||
        !sameName(news.primaryFabricId, output.primaryFabricId) ||
        !sameName(news.recoveryFabricId, output.recoveryFabricId) ||
        (olds !== undefined &&
          ((news.failoverDeploymentModel ?? "ResourceManager") !==
            (olds.failoverDeploymentModel ?? "ResourceManager") ||
            JSON.stringify(news.providerSpecificInput ?? null) !==
              JSON.stringify(olds.providerSpecificInput ?? null)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const where: Where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: vault,
        recoveryPlanName:
          output?.recoveryPlanName ??
          olds?.name ??
          (yield* createSiteRecoveryName(id)),
      };
      const observed = yield* getPlan(where);
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(where, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        recoveryPlanName:
          news.name ??
          output?.recoveryPlanName ??
          (yield* createSiteRecoveryName(id)),
      };
      const groups = withImplicitGroups(news.groups);
      const desiredKey = groupsKey(groups);
      const get = getPlan(where);
      const converged = (plan: Observed) =>
        groupsKey(observedGroups(plan)) === desiredKey ? undefined : "Updating";

      // Observe.
      const observed = yield* get;

      // Ensure / sync: create when missing, PATCH the groups on a delta.
      if (observed === undefined) {
        yield* asr.CreateReplicationRecoveryPlan({
          ...where,
          properties: {
            primaryFabricId: news.primaryFabricId,
            recoveryFabricId: news.recoveryFabricId,
            failoverDeploymentModel:
              news.failoverDeploymentModel ?? "ResourceManager",
            groups,
            ...(news.providerSpecificInput
              ? { providerSpecificInput: news.providerSpecificInput }
              : {}),
          },
        });
      } else if (converged(observed) !== undefined) {
        yield* asr.UpdateReplicationRecoveryPlan({
          ...where,
          properties: { groups },
        });
      }
      const fresh = yield* waitForProvisioned(
        `site recovery recovery plan ${where.recoveryPlanName}`,
        get,
        converged,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        recoveryPlanName: output.recoveryPlanName,
      };
      yield* ignoreNotFound(asr.DeleteReplicationRecoveryPlan(where));
      yield* waitUntilGone(
        `site recovery recovery plan ${output.recoveryPlanName}`,
        getPlan(where),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
