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

export interface AgentSpaceProps {
  /** Resource group the agent space is created in. Changing it replaces the space. */
  resourceGroup: string;
  /**
   * Agent space name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the space.
   */
  name?: string;
  /**
   * Azure location (SRE Agent regions, e.g. `swedencentral`, `eastus2`).
   * Changing it replaces the space.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the agent space. */
  description?: string;
  /** Policies propagated to member agents. */
  policies?: app.AgentSpacePoliciesInput;
  /** Maximum number of member agents. */
  maxAgentCount?: number;
  /** Service Tree ID (UUID) associated with the space. */
  serviceTreeId?: string;
  /** Managed identity of the agent space. */
  identity?: ContainerAppsIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AgentSpace extends Resource<
  "Azure.ContainerApps.AgentSpace",
  AgentSpaceProps,
  {
    /** Name of the agent space. */
    agentSpaceName: string;
    /** ARM resource ID; reference it as an agent's `agentSpaceId`. */
    agentSpaceId: string;
    /** Resource group that holds the agent space. */
    resourceGroup: string;
    /** Location of the agent space. */
    location: string;
    /** Number of agents in the space. */
    currentAgentCount: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SRE agent space (`Microsoft.App/agentSpaces`) — groups SRE
 * agents under shared policies and data connectors.
 *
 * Agent spaces are a preview feature enabled per tenant/subscription;
 * elsewhere Azure rejects them with `AgentSpaceNotAllowed`.
 *
 * @see https://learn.microsoft.com/azure/sre-agent/overview
 *
 * ### Creating an Agent Space
 * **Example:** Space shared by several agents
 * ```typescript
 * const space = yield* Azure.ContainerApps.AgentSpace("ops", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "swedencentral",
 *   description: "Production operations",
 *   maxAgentCount: 5,
 * });
 * yield* Azure.ContainerApps.Agent("sre", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "swedencentral",
 *   agentSpaceId: space.agentSpaceId,
 * });
 * ```
 *
 * @resource
 */
export const AgentSpace = Resource<AgentSpace>(
  "Azure.ContainerApps.AgentSpace",
);

const createSpaceName = (id: string) => createContainerAppsName(id, 32);

const getSpace = (
  subscriptionId: string,
  resourceGroupName: string,
  agentSpaceName: string,
) =>
  orUndefinedIfNotFound(
    app.GetAgentSpace({ subscriptionId, resourceGroupName, agentSpaceName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: app.GetAgentSpaceResponse,
): AgentSpace["Attributes"] => ({
  agentSpaceName: name,
  agentSpaceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  currentAgentCount: observed.properties?.currentAgentCount,
  tags: userTags(observed.tags),
});

const toProperties = (props: AgentSpaceProps) => ({
  description: props.description,
  policies: props.policies,
  maxAgentCount: props.maxAgentCount,
  serviceTreeId: props.serviceTreeId,
});

export const AgentSpaceProvider = () =>
  Provider.succeed(AgentSpace, {
    stables: ["agentSpaceName", "agentSpaceId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* app
        .ListAgentSpaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAgentSpaceBySubscription", page),
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
        (news.name !== undefined && news.name !== output.agentSpaceName) ||
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
        output?.agentSpaceName ?? olds?.name ?? (yield* createSpaceName(id));
      const observed = yield* getSpace(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.agentSpaceName ?? (yield* createSpaceName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = toProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        agentSpaceName: name,
      };
      const get = getSpace(subscriptionId, resourceGroup, name);
      const ready = waitForProvisioned(
        `agent space ${name}`,
        get,
        (space) => space.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* app.AgentSpacesCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(news.identity),
          properties,
        });
      }
      observed = yield* ready;

      // Sync: PATCH the observed deltas.
      const propertiesDiffer =
        !matchesDesired(properties, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)));
      const identityDiffers = !identityMatches(
        news.identity,
        observed.identity,
      );
      if (
        propertiesDiffer ||
        identityDiffers ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* app.UpdateAgentSpace({
          ...where,
          tags,
          identity: identityDiffers ? toIdentity(news.identity) : undefined,
          properties: propertiesDiffer ? properties : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteAgentSpace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          agentSpaceName: output.agentSpaceName,
        }),
      );
      yield* waitUntilGone(
        `agent space ${output.agentSpaceName}`,
        getSpace(subscriptionId, output.resourceGroup, output.agentSpaceName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
