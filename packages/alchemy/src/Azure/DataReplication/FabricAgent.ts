import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
  createDataReplicationName,
  DATA_REPLICATION_NAMESPACE,
  type DataReplicationCustomProperties,
  isFabricOwnedByStack,
  matchesDesired,
  sameName,
} from "./Shared.ts";

/** Entra service principal a fabric agent uses. */
export interface FabricAgentIdentity {
  /** Tenant ID of the service principal. */
  tenantId: string;
  /** Client (application) ID of the service principal. */
  applicationId: string;
  /** Object ID of the service principal. */
  objectId: string;
  /** Audience the agent requests tokens for. */
  audience: string;
  /** Entra authority, e.g. `https://login.microsoftonline.com/<tenant>`. */
  aadAuthority: string;
}

export interface FabricAgentProps {
  /** Resource group of the fabric. Changing it replaces the agent. */
  resourceGroup: string;
  /** Name of the fabric the agent belongs to. Changing it replaces the agent. */
  fabric: string;
  /**
   * Name of the agent: letters and digits only. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the agent.
   */
  name?: string;
  /** ID of the machine (appliance) running the agent. Changing it replaces the agent. */
  machineId: string;
  /** Name of the machine running the agent. Changing it replaces the agent. */
  machineName: string;
  /**
   * Service principal the agent authenticates to the service with.
   * Changing it replaces the agent.
   */
  authenticationIdentity: FabricAgentIdentity;
  /**
   * Service principal the agent accesses Azure resources with. Changing it
   * replaces the agent.
   */
  resourceAccessIdentity: FabricAgentIdentity;
  /**
   * Agent settings, discriminated by `instanceType` (`VMware`), e.g.
   * `{ instanceType: "VMware", biosId, marsAuthenticationIdentity }`.
   * Changing them replaces the agent.
   */
  customProperties: DataReplicationCustomProperties;
}

export interface FabricAgent extends Resource<
  "Azure.DataReplication.FabricAgent",
  FabricAgentProps,
  {
    /** Name of the agent. */
    fabricAgentName: string;
    /** Name of the fabric. */
    fabric: string;
    /** Resource group of the fabric. */
    resourceGroup: string;
    /** ARM resource ID of the agent. */
    fabricAgentId: string;
    /** Machine ID the agent runs on. */
    machineId: string | undefined;
    /** Machine name the agent runs on. */
    machineName: string | undefined;
    /** Correlation ID of the agent. */
    correlationId: string | undefined;
    /** Whether the agent is sending heartbeats. */
    isResponsive: boolean | undefined;
    /** Agent version. */
    versionNumber: string | undefined;
    /** Provisioning state of the agent. */
    provisioningState: string | undefined;
    /** Observed agent settings. */
    customProperties: Record<string, unknown> | undefined;
  },
  never,
  Providers
> {}

/**
 * Registers the fabric agent of an on-premises Azure Migrate appliance
 * with an Azure Site Recovery data replication fabric
 * (`Microsoft.DataReplication/replicationFabrics/fabricAgents`). The agent
 * is the appliance-side component that discovers and replicates machines.
 *
 * Agents cannot be tagged; Alchemy treats one as owned when its fabric is
 * tagged for the current stack and stage. All settings are immutable, so
 * any change replaces the agent.
 *
 * @see https://learn.microsoft.com/rest/api/datareplication/fabric-agent/create
 *
 * ### Registering an Agent
 * **Example:** VMware appliance agent
 * ```typescript
 * const identity = {
 *   tenantId,
 *   applicationId: appId,
 *   objectId: spObjectId,
 *   audience: `api://${appId}`,
 *   aadAuthority: `https://login.microsoftonline.com/${tenantId}`,
 * };
 * const agent = yield* Azure.DataReplication.FabricAgent("agent", {
 *   resourceGroup: group.resourceGroupName,
 *   fabric: fabric.fabricName,
 *   machineId: "appliance-machine-id",
 *   machineName: "appliance01",
 *   authenticationIdentity: identity,
 *   resourceAccessIdentity: identity,
 *   customProperties: {
 *     instanceType: "VMware",
 *     biosId: "appliance-bios-id",
 *     marsAuthenticationIdentity: identity,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const FabricAgent = Resource<FabricAgent>(
  "Azure.DataReplication.FabricAgent",
);

type Observed = dr.GetFabricAgentResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  fabricName: string;
  fabricAgentName: string;
}

const getAgent = (where: Where) =>
  orUndefinedIfNotFound(dr.GetFabricAgent(where));

const customOf = (agent: Observed) =>
  (agent.properties?.customProperties ?? undefined) as
    | Record<string, unknown>
    | undefined;

const toAttrs = (
  resourceGroup: string,
  fabric: string,
  name: string,
  agent: Observed,
): FabricAgent["Attributes"] => ({
  fabricAgentName: name,
  fabric,
  resourceGroup,
  fabricAgentId: agent.id ?? "",
  machineId: agent.properties?.machineId,
  machineName: agent.properties?.machineName,
  correlationId: agent.properties?.correlationId,
  isResponsive: agent.properties?.isResponsive,
  versionNumber: agent.properties?.versionNumber,
  provisioningState: agent.properties?.provisioningState,
  customProperties: customOf(agent),
});

const desiredOf = (news: FabricAgentProps) => ({
  machineId: news.machineId,
  machineName: news.machineName,
  authenticationIdentity: news.authenticationIdentity,
  resourceAccessIdentity: news.resourceAccessIdentity,
  customProperties: news.customProperties,
});

export const FabricAgentProvider = () =>
  Provider.succeed(FabricAgent, {
    stables: ["fabricAgentName", "fabric", "resourceGroup", "fabricAgentId"],

    // A fabric child that disappears with its fabric.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.fabric, output.fabric) ||
        (news.name !== undefined &&
          !sameName(news.name, output.fabricAgentName)) ||
        (olds !== undefined &&
          JSON.stringify(desiredOf(olds)) !== JSON.stringify(desiredOf(news)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fabric = output?.fabric ?? olds?.fabric;
      if (resourceGroup === undefined || fabric === undefined) return undefined;
      const name =
        output?.fabricAgentName ??
        olds?.name ??
        (yield* createDataReplicationName(id));
      const observed = yield* getAgent({
        subscriptionId,
        resourceGroupName: resourceGroup,
        fabricName: fabric,
        fabricAgentName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, fabric, name, observed);
      if (output !== undefined) return attrs;
      return (yield* isFabricOwnedByStack(
        subscriptionId,
        resourceGroup,
        fabric,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const name =
        news.name ??
        output?.fabricAgentName ??
        (yield* createDataReplicationName(id));
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        fabricName: news.fabric,
        fabricAgentName: name,
      };
      const get = getAgent(where);
      const desired = desiredOf(news);

      // Observe; PUT (an upsert LRO) only when missing or drifted.
      const observed = yield* get;
      if (
        observed === undefined ||
        !matchesDesired(
          { ...observed.properties, customProperties: customOf(observed) },
          desired,
        )
      ) {
        yield* dr.CreateFabricAgent({ ...where, properties: desired });
      }
      const fresh = yield* waitForProvisioned(
        `data replication fabric agent ${name}`,
        get,
        (agent) => agent.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(news.resourceGroup, news.fabric, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        fabricName: output.fabric,
        fabricAgentName: output.fabricAgentName,
      };
      yield* ignoreNotFound(dr.DeleteFabricAgent(where));
      yield* waitUntilGone(
        `data replication fabric agent ${output.fabricAgentName}`,
        getAgent(where),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.DataReplication.Fabric"] },
  });
