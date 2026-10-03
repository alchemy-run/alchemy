import * as synapse from "@distilled.cloud/azure/synapse";
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
import { lower } from "./common.ts";

export interface PrivateLinkHubProps {
  /** Resource group the hub is created in. Changing it replaces the hub. */
  resourceGroup: string;
  /**
   * Hub name: 1-45 lowercase letters and digits. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the hub.
   */
  name?: string;
  /**
   * Azure location of the hub. Changing it replaces the hub.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PrivateLinkHub extends Resource<
  "Azure.Synapse.PrivateLinkHub",
  PrivateLinkHubProps,
  {
    /** Name of the hub. */
    privateLinkHubName: string;
    /** ARM resource ID of the hub; the target of a `web` private endpoint. */
    privateLinkHubId: string;
    /** Resource group that holds the hub. */
    resourceGroup: string;
    /** Location of the hub. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Synapse Private Link Hub — the target for a private endpoint
 * (sub-resource `web`) that serves Synapse Studio over a private network.
 * Free; one hub can serve every workspace in a region.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/security/synapse-private-link-hubs
 *
 * ### Creating a Hub
 * **Example:** Private Link Hub
 * ```typescript
 * const hub = yield* Azure.Synapse.PrivateLinkHub("studio", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Hub with tags
 * ```typescript
 * const hub = yield* Azure.Synapse.PrivateLinkHub("studio", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "data" },
 * });
 * ```
 *
 * @resource
 */
export const PrivateLinkHub = Resource<PrivateLinkHub>(
  "Azure.Synapse.PrivateLinkHub",
);

type ObservedHub = synapse.GetPrivateLinkHubResponse;

const createHubName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 45,
    lowercase: true,
    delimiter: "",
  });
  return name.replace(/[^a-z0-9]/g, "");
});

const getHub = (
  subscriptionId: string,
  resourceGroupName: string,
  privateLinkHubName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetPrivateLinkHub({
      subscriptionId,
      resourceGroupName,
      privateLinkHubName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  hub: ObservedHub,
): PrivateLinkHub["Attributes"] => ({
  privateLinkHubName: name,
  privateLinkHubId: hub.id ?? "",
  resourceGroup,
  location: hub.location,
  tags: userTags(hub.tags),
});

export const PrivateLinkHubProvider = () =>
  Provider.succeed(PrivateLinkHub, {
    stables: [
      "privateLinkHubName",
      "privateLinkHubId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* synapse
        .ListPrivateLinkHubs({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPrivateLinkHubs", page),
          ),
        );
      return (page.value ?? []).flatMap((hub) => {
        const group = resourceGroupOf(hub.id);
        return hasAnyAlchemyTag(hub.tags) &&
          group !== undefined &&
          hub.name !== undefined
          ? [toAttrs(group, hub.name, hub)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.privateLinkHubName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
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
        output?.privateLinkHubName ?? olds?.name ?? (yield* createHubName(id));
      const observed = yield* getHub(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.privateLinkHubName ?? (yield* createHubName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateLinkHubName: name,
      };
      const get = getHub(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync tags against the observed hub.
      if (observed === undefined) {
        yield* synapse.PrivateLinkHubsCreateOrUpdate({
          ...where,
          location,
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* synapse.UpdatePrivateLinkHub({ ...where, tags });
      }

      const fresh = yield* waitForProvisioned(
        `synapse private link hub ${name}`,
        get,
        (hub) =>
          tagsDiffer(hub.tags, tags)
            ? "Updating"
            : hub.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeletePrivateLinkHub({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateLinkHubName: output.privateLinkHubName,
        }),
      );
      yield* waitUntilGone(
        `synapse private link hub ${output.privateLinkHubName}`,
        getHub(subscriptionId, output.resourceGroup, output.privateLinkHubName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
