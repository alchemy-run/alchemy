import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  createContainerAppsName,
  fingerprint,
  identityMatches,
  lower,
  matchesDesired,
  sameLocation,
  toIdentity,
  type ContainerAppsIdentity,
} from "./common.ts";

export interface AgentProps {
  /** Resource group the agent is created in. Changing it replaces the agent. */
  resourceGroup: string;
  /**
   * Agent name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the agent.
   */
  name?: string;
  /**
   * Azure location (SRE Agent regions, e.g. `swedencentral`, `eastus2`).
   * Changing it replaces the agent.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the agent space the agent belongs to. */
  agentSpaceId?: string;
  /** Knowledge graph (managed resources the agent can reason about). */
  knowledgeGraphConfiguration?: app.KnowledgeGraphConfiguration;
  /** What the agent may do (access level and mode). */
  actionConfiguration?: app.ActionConfiguration;
  /** Application Insights destination for agent logs. */
  logConfiguration?: app.LogConfiguration;
  /** Incident platform integration. */
  incidentManagementConfiguration?: app.IncidentManagementConfiguration;
  /**
   * Upgrade channel.
   * @default "Stable"
   */
  upgradeChannel?: "Preview" | "Stable";
  /** Default AI model of the agent. */
  defaultModel?: app.DefaultModel;
  /**
   * Managed identity the agent acts with. An agent requires one.
   * @default `{ type: "SystemAssigned" }`
   */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Agent extends Resource<
  "Azure.ContainerApps.Agent",
  AgentProps,
  {
    /** Name of the agent. */
    agentName: string;
    /** ARM resource ID of the agent. */
    agentId: string;
    /** Resource group that holds the agent. */
    resourceGroup: string;
    /** Location of the agent. */
    location: string;
    /** Chat and API endpoint of the agent. */
    agentEndpoint: string | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SRE Agent (`Microsoft.App/agents`) — an AI operations agent
 * that investigates incidents and acts on the Azure resources it is given
 * access to through its managed identity.
 *
 * Agents are billed in Azure Agent Units while running (an always-on
 * baseline plus usage).
 *
 * @see https://learn.microsoft.com/azure/sre-agent/overview
 *
 * ### Creating an Agent
 * **Example:** Agent with a system-assigned identity
 * ```typescript
 * const agent = yield* Azure.ContainerApps.Agent("sre", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "swedencentral",
 *   upgradeChannel: "Stable",
 * });
 * // grant agent.principalId Reader on the resources it should watch
 * ```
 *
 * @resource
 */
export const Agent = Resource<Agent>("Azure.ContainerApps.Agent");

const createAgentName = (id: string) => createContainerAppsName(id, 32);

const DEFAULT_IDENTITY: ContainerAppsIdentity = { type: "SystemAssigned" };

const getAgent = (
  subscriptionId: string,
  resourceGroupName: string,
  agentName: string,
) =>
  orUndefinedIfNotFound(
    app.GetAgent({ subscriptionId, resourceGroupName, agentName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetAgentResponse,
): Agent["Attributes"] => ({
  agentName: name,
  agentId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  agentEndpoint: observed.properties?.agentEndpoint,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const toProperties = (props: AgentProps) => ({
  agentSpaceId: props.agentSpaceId,
  knowledgeGraphConfiguration: props.knowledgeGraphConfiguration,
  actionConfiguration: props.actionConfiguration,
  logConfiguration: props.logConfiguration,
  incidentManagementConfiguration: props.incidentManagementConfiguration,
  upgradeChannel: props.upgradeChannel ?? "Stable",
  defaultModel: props.defaultModel,
});

export const AgentProvider = () =>
  Provider.succeed(Agent, {
    stables: ["agentName", "agentId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListAgentBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAgentBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.agentName) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.agentName ?? olds?.name ?? (yield* createAgentName(id));
      const observed = yield* getAgent(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.agentName ?? (yield* createAgentName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = news.identity ?? DEFAULT_IDENTITY;
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        agentName: name,
      };
      const get = getAgent(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `agent ${name}`,
        get,
        (agent) => agent.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* app.AgentsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(identity),
          properties,
        });
      }
      observed = yield* ready;

      // Sync: PATCH the observed deltas (removed settings are detected
      // against the previous props).
      const propertiesDiffer =
        !matchesDesired(properties, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)));
      const identityDiffers = !identityMatches(identity, observed.identity);
      if (
        propertiesDiffer ||
        identityDiffers ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* app.UpdateAgent({
          ...where,
          tags,
          identity: identityDiffers ? toIdentity(identity) : undefined,
          properties: propertiesDiffer ? properties : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteAgent({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          agentName: output.agentName,
        }),
      );
      yield* waitUntilGone(
        `agent ${output.agentName}`,
        getAgent(subscriptionId, output.resourceGroup, output.agentName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ContainerApps.AgentSpace",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
