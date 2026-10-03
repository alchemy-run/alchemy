import * as chaos from "@distilled.cloud/azure/chaos";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { canonical } from "./targetPath.ts";

/** A key/value setting of an experiment action. */
export interface ExperimentActionParameter {
  /** Name of the setting, e.g. `name`, `protocol`, `action`, `abruptShutdown`. */
  key: string;
  /** Value of the setting (JSON-encoded for arrays, e.g. `["*"]`). */
  value: string;
}

/** Run a fault for a fixed duration (most faults). */
export interface ExperimentContinuousAction {
  type: "continuous";
  /** Fault URN, e.g. a capability's `urn`. */
  name: string;
  /** ISO 8601 duration of the fault, e.g. `PT10M`. */
  duration: string;
  /** `id` of the selector whose targets the fault runs against. */
  selectorId: string;
  /** Fault parameters. */
  parameters?: ExperimentActionParameter[];
}

/** Run a fault once (e.g. a virtual machine redeploy). */
export interface ExperimentDiscreteAction {
  type: "discrete";
  /** Fault URN, e.g. a capability's `urn`. */
  name: string;
  /** `id` of the selector whose targets the fault runs against. */
  selectorId: string;
  /** Fault parameters. */
  parameters?: ExperimentActionParameter[];
}

/** Pause the branch. */
export interface ExperimentDelayAction {
  type: "delay";
  /** Delay URN, `urn:csci:microsoft:chaosStudio:TimedDelay/1.0`. */
  name: string;
  /** ISO 8601 duration of the delay, e.g. `PT5M`. */
  duration: string;
}

export type ExperimentAction =
  | ExperimentContinuousAction
  | ExperimentDiscreteAction
  | ExperimentDelayAction;

/** A branch: actions that run sequentially, in parallel with sibling branches. */
export interface ExperimentBranch {
  /** Name of the branch. */
  name: string;
  /** Actions of the branch, run in order. */
  actions: ExperimentAction[];
}

/** A step: branches that run in parallel; steps run in order. */
export interface ExperimentStep {
  /** Name of the step. */
  name: string;
  /** Branches of the step. */
  branches: ExperimentBranch[];
}

/** Filter that narrows the targets of a selector. */
export interface ExperimentSelectorFilter {
  type: "Simple";
  /** Filter parameters. */
  parameters?: {
    /** Only targets in these availability zones. */
    zones?: string[];
  };
}

/** Selects an explicit list of Chaos targets. */
export interface ExperimentListSelector {
  type: "List";
  /** Selector ID referenced by action `selectorId`s. */
  id: string;
  /** Chaos targets (`target.targetId`). */
  targets: { type?: "ChaosTarget"; id: string }[];
  /** Optional target filter. */
  filter?: ExperimentSelectorFilter;
}

/** Selects Chaos targets with an Azure Resource Graph query. */
export interface ExperimentQuerySelector {
  type: "Query";
  /** Selector ID referenced by action `selectorId`s. */
  id: string;
  /** Azure Resource Graph query that returns the target resources. */
  queryString: string;
  /** Subscriptions the query runs against. */
  subscriptionIds: string[];
  /** Optional target filter. */
  filter?: ExperimentSelectorFilter;
}

export type ExperimentSelector =
  | ExperimentListSelector
  | ExperimentQuerySelector;

export type ExperimentIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

/** Managed identity the experiment runs faults as. */
export interface ExperimentIdentity {
  /** Kind of managed identity. */
  type: ExperimentIdentityType;
  /** Resource IDs of user-assigned identities (for `UserAssigned` types). */
  userAssignedIdentities?: string[];
}

export interface ExperimentProps {
  /** Resource group the experiment is created in. Changing it replaces the experiment. */
  resourceGroup: string;
  /**
   * Experiment name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the experiment.
   */
  name?: string;
  /**
   * Azure region; must be a region Chaos Studio supports. Defaults to the
   * provider's location. Changing it replaces the experiment.
   */
  location?: string;
  /**
   * Managed identity the experiment runs faults as. Grant it the roles each
   * fault needs on its targets before starting the experiment.
   * @default { type: "SystemAssigned" }
   */
  identity?: ExperimentIdentity;
  /** Steps of the experiment, run in order. */
  steps: ExperimentStep[];
  /** Target selectors referenced by the actions. */
  selectors: ExperimentSelector[];
  /** User tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface Experiment extends Resource<
  "Azure.Chaos.Experiment",
  ExperimentProps,
  {
    /** Name of the experiment. */
    experimentName: string;
    /** ARM resource ID of the experiment. */
    experimentId: string;
    /** Resource group that holds the experiment. */
    resourceGroup: string;
    /** Location of the experiment. */
    location: string;
    /** Kind of managed identity the experiment runs as. */
    identityType: string;
    /**
     * Principal ID of the system-assigned identity; grant it access to the
     * targets. Empty without a system-assigned identity.
     */
    principalId: string;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Chaos Studio experiment: steps of faults run against selected
 * Chaos targets.
 *
 * Creating an experiment is free; Chaos Studio bills per target-action
 * minute only while an experiment runs. Alchemy creates and updates the
 * experiment definition but never starts it. The experiment's managed
 * identity needs the roles each fault requires on its targets (see the
 * fault library) before a run succeeds.
 *
 * @see https://learn.microsoft.com/azure/chaos-studio/chaos-studio-overview
 *
 * ### Creating an Experiment
 * **Example:** Block traffic through a network security group for 10 minutes
 * ```typescript
 * const target = yield* Azure.Chaos.Target("web-nsg-target", {
 *   parentResourceId: nsg.networkSecurityGroupId,
 *   targetType: "Microsoft-NetworkSecurityGroup",
 * });
 * const securityRule = yield* Azure.Chaos.Capability("security-rule", {
 *   targetId: target.targetId,
 *   capabilityType: "SecurityRule-1.1",
 * });
 * const experiment = yield* Azure.Chaos.Experiment("block-web", {
 *   resourceGroup: group.resourceGroupName,
 *   selectors: [
 *     { type: "List", id: "nsgs", targets: [{ id: target.targetId }] },
 *   ],
 *   steps: [
 *     {
 *       name: "step1",
 *       branches: [
 *         {
 *           name: "branch1",
 *           actions: [
 *             {
 *               type: "continuous",
 *               name: securityRule.urn,
 *               duration: "PT10M",
 *               selectorId: "nsgs",
 *               parameters: [
 *                 { key: "name", value: "BlockInbound" },
 *                 { key: "protocol", value: "Any" },
 *                 { key: "sourceAddresses", value: '["*"]' },
 *                 { key: "destinationAddresses", value: '["*"]' },
 *                 { key: "destinationPortRanges", value: '["*"]' },
 *                 { key: "sourcePortRanges", value: '["*"]' },
 *                 { key: "action", value: "Deny" },
 *                 { key: "direction", value: "Inbound" },
 *                 { key: "priority", value: "100" },
 *               ],
 *             },
 *           ],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Granting the Experiment Access
 * **Example:** Let the system-assigned identity manage the NSG
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("chaos-nsg", {
 *   scope: nsg.networkSecurityGroupId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.NetworkContributor,
 *   principalId: experiment.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const Experiment = Resource<Experiment>("Azure.Chaos.Experiment");

type ObservedExperiment = chaos.Experiment;

const getExperiment = (
  subscriptionId: string,
  resourceGroupName: string,
  experimentName: string,
) =>
  orUndefinedIfNotFound(
    chaos.GetExperiment({ subscriptionId, resourceGroupName, experimentName }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  experiment: ObservedExperiment,
): Experiment["Attributes"] => ({
  experimentName: name,
  experimentId: experiment.id ?? "",
  resourceGroup,
  location: experiment.location,
  identityType: experiment.identity?.type ?? "None",
  principalId: experiment.identity?.principalId ?? "",
  provisioningState: experiment.properties?.provisioningState,
  tags: userTags(experiment.tags),
});

const toSdkAction = (action: ExperimentAction): chaos.ChaosExperimentAction =>
  action.type === "delay"
    ? { type: "delay", name: action.name, duration: action.duration }
    : action.type === "continuous"
      ? {
          type: "continuous",
          name: action.name,
          duration: action.duration,
          selectorId: action.selectorId,
          parameters: action.parameters ?? [],
        }
      : {
          type: "discrete",
          name: action.name,
          selectorId: action.selectorId,
          parameters: action.parameters ?? [],
        };

const toSdkSelector = (
  selector: ExperimentSelector,
): chaos.ChaosTargetSelector =>
  selector.type === "List"
    ? {
        type: "List",
        id: selector.id,
        targets: selector.targets.map((target) => ({
          type: target.type ?? "ChaosTarget",
          id: target.id,
        })),
        filter: selector.filter,
      }
    : {
        type: "Query",
        id: selector.id,
        queryString: selector.queryString,
        subscriptionIds: selector.subscriptionIds,
        filter: selector.filter,
      };

const desiredProperties = (news: ExperimentProps) => ({
  steps: news.steps.map((step): chaos.ChaosExperimentStep => ({
    name: step.name,
    branches: step.branches.map((branch) => ({
      name: branch.name,
      actions: branch.actions.map(toSdkAction),
    })),
  })),
  selectors: news.selectors.map(toSdkSelector),
});

/** Comparable form of a definition: ARM ids compared case-insensitively. */
const definitionKey = (properties: {
  steps: readonly chaos.ChaosExperimentStep[];
  selectors: readonly chaos.ChaosTargetSelector[];
}) =>
  canonical({
    steps: properties.steps.map((step) => ({
      name: step.name,
      branches: step.branches.map((branch) => ({
        name: branch.name,
        actions: branch.actions.map((action) => ({
          type: action.type,
          name: action.name,
          duration: action.duration,
          selectorId: action.selectorId,
          parameters:
            action.type === "delay" ? undefined : (action.parameters ?? []),
        })),
      })),
    })),
    selectors: properties.selectors.map((selector) => ({
      type: selector.type,
      id: selector.id,
      targets: selector.targets?.map((target) => ({
        type: target.type,
        id: target.id.toLowerCase(),
      })),
      queryString: selector.queryString,
      subscriptionIds: selector.subscriptionIds,
      filter: selector.filter,
    })),
  });

const desiredIdentity = (
  identity: ExperimentIdentity | undefined,
): chaos.ExperimentsCreateOrUpdateRequestIdentity => {
  const type = identity?.type ?? "SystemAssigned";
  const ids = identity?.userAssignedIdentities ?? [];
  return ids.length > 0
    ? {
        type,
        userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
      }
    : { type };
};

const identityKey = (identity: {
  type: string;
  userAssignedIdentities?: Record<string, unknown>;
}) =>
  canonical({
    type: identity.type.replaceAll(" ", "").toLowerCase(),
    ids: Object.keys(identity.userAssignedIdentities ?? {})
      .map((id) => id.toLowerCase())
      .sort(),
  });

export const ExperimentProvider = () =>
  Provider.succeed(Experiment, {
    stables: ["experimentName", "experimentId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* chaos
        .ListExperimentAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListExperimentAll", page),
          ),
        );
      return (page.value ?? []).flatMap((experiment) => {
        const group = resourceGroupOf(experiment.id);
        return hasAnyAlchemyTag(experiment.tags) &&
          group !== undefined &&
          experiment.name !== undefined
          ? [toAttrs(group, experiment.name, experiment)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.experimentName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes.
      if (typeof resourceGroup !== "string") return undefined;
      const name =
        output?.experimentName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getExperiment(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Chaos");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.experimentName ?? (yield* createName(id));
      const tags = yield* desiredTags(id, news.tags);
      const identity = desiredIdentity(news.identity);
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        experimentName: name,
      };
      const get = getExperiment(subscriptionId, resourceGroup, name);

      const waitReady = waitForProvisioned(
        `chaos experiment ${name}`,
        get,
        (experiment) => experiment.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync the definition: PUT is the only API that changes
      // steps/selectors.
      if (
        observed === undefined ||
        definitionKey(observed.properties) !== definitionKey(properties)
      ) {
        yield* chaos.ExperimentsCreateOrUpdate({
          ...where,
          location: observed?.location ?? news.location ?? env.location,
          identity,
          tags,
          properties,
        });
        observed = yield* waitReady;
      }

      // Sync identity and tags against the observed experiment: Chaos
      // Studio drops the tags of a creating PUT, so this PATCH also lands
      // the ownership tags of a new experiment.
      let fresh = observed;
      if (
        identityKey(observed.identity ?? { type: "None" }) !==
          identityKey(identity) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* chaos.UpdateExperiment({ ...where, identity, tags });
        fresh = yield* waitReady;
      }
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        chaos.DeleteExperiment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          experimentName: output.experimentName,
        }),
      );
      yield* waitUntilGone(
        `chaos experiment ${output.experimentName}`,
        getExperiment(
          subscriptionId,
          output.resourceGroup,
          output.experimentName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
