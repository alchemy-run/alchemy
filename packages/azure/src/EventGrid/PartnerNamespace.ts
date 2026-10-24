import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createEventGridName,
  ipRulesDiffer,
  redactKeys,
  sameName,
  setIfChanged,
  toIpRules,
  type EventGridInboundIpRule,
} from "./common.ts";

/** How events published to a partner namespace are routed to partner topics. */
export type PartnerTopicRoutingMode = "SourceEventAttribute" | "ChannelNameHeader";

export interface PartnerNamespaceProps {
  /**
   * Resource group the namespace is created in. Changing it replaces the
   * namespace.
   */
  resourceGroup: string;
  /**
   * Namespace name: 3-50 letters, digits, and hyphens, unique per region.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the namespace.
   */
  name?: string;
  /**
   * Azure location of the namespace. Changing it replaces the namespace.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the partner registration the namespace publishes
   * for, e.g. `registration.partnerRegistrationId` of an
   * `Azure.EventGrid.PartnerRegistration`.
   *
   * :::caution
   * Changing it replaces the namespace (and deletes its channels).
   * :::
   */
  partnerRegistration: string;
  /**
   * How published events find their partner topic: the CloudEvents `source`
   * attribute, or the `aeg-channel-name` header.
   *
   * :::caution
   * Changing it replaces the namespace (and deletes its channels).
   * :::
   * @default "SourceEventAttribute"
   */
  partnerTopicRoutingMode?: PartnerTopicRoutingMode;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * IP ranges allowed to publish while `publicNetworkAccess` is `Enabled`.
   * An empty list (the default) allows every address.
   * @default []
   */
  inboundIpRules?: EventGridInboundIpRule[];
  /**
   * Minimum TLS version publishers must use.
   * @default Azure's default (`1.0`)
   */
  minimumTlsVersionAllowed?: "1.0" | "1.1" | "1.2";
  /**
   * Require Microsoft Entra ID to publish (disables SAS keys). When `true`,
   * `primaryKey`/`secondaryKey` are not returned.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PartnerNamespace extends Resource<
  "Azure.EventGrid.PartnerNamespace",
  PartnerNamespaceProps,
  {
    /** Name of the namespace. */
    partnerNamespaceName: string;
    /** ARM resource ID of the namespace. */
    partnerNamespaceId: string;
    /** Resource group that holds the namespace. */
    resourceGroup: string;
    /** Location of the namespace. */
    location: string;
    /** ARM resource ID of the partner registration. */
    partnerRegistration: string;
    /** Routing mode of published events. */
    partnerTopicRoutingMode: string;
    /** Publish endpoint, e.g. `https://{name}.eastus-1.eventgrid.azure.net/api/events`. */
    endpoint: string | undefined;
    /** Primary SAS key (absent when `disableLocalAuth` is `true`). */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary SAS key (absent when `disableLocalAuth` is `true`). */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Event Grid partner namespace (`Microsoft.EventGrid/partnerNamespaces`)
 * — the regional endpoint a SaaS partner publishes events to. Each
 * `Azure.EventGrid.Channel` in the namespace creates one partner topic in a
 * subscriber's resource group and routes matching events to it.
 *
 * @see https://learn.microsoft.com/azure/event-grid/onboard-partner
 *
 * ### Creating a Partner Namespace
 * **Example:** Namespace for a partner registration
 * ```typescript
 * const registration = yield* Azure.EventGrid.PartnerRegistration("contoso");
 * const namespace = yield* Azure.EventGrid.PartnerNamespace("contoso-events", {
 *   partnerRegistration: registration.partnerRegistrationId,
 * });
 * ```
 *
 * **Example:** Route events by channel name and require TLS 1.2
 * ```typescript
 * const namespace = yield* Azure.EventGrid.PartnerNamespace("contoso-events", {
 *   partnerRegistration: registration.partnerRegistrationId,
 *   partnerTopicRoutingMode: "ChannelNameHeader",
 *   minimumTlsVersionAllowed: "1.2",
 * });
 * ```
 *
 * ### Network Restrictions
 * **Example:** Allow publishing from one range only
 * ```typescript
 * const namespace = yield* Azure.EventGrid.PartnerNamespace("contoso-events", {
 *   partnerRegistration: registration.partnerRegistrationId,
 *   inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * @resource
 */
export const PartnerNamespace = GroupedResource<PartnerNamespace>(
  "Azure.EventGrid.PartnerNamespace",
);

type ObservedNamespace = Pick<
  eventgrid.PartnerNamespace,
  "id" | "location" | "properties" | "tags"
>;

const getNamespace = (
  subscriptionId: string,
  resourceGroupName: string,
  partnerNamespaceName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetPartnerNamespace({ subscriptionId, resourceGroupName, partnerNamespaceName }),
  );

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  partnerNamespaceName: string,
  disableLocalAuth: boolean | undefined,
) =>
  disableLocalAuth
    ? Effect.succeed(undefined)
    : orUndefinedIfNotFound(
        eventgrid.ListPartnerNamespaceSharedAccessKeys({
          subscriptionId,
          resourceGroupName,
          partnerNamespaceName,
        }),
      );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedNamespace,
  keys: { key1?: string; key2?: string } | undefined,
): PartnerNamespace["Attributes"] => ({
  partnerNamespaceName: name,
  partnerNamespaceId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  partnerRegistration: observed.properties?.partnerRegistrationFullyQualifiedId ?? "",
  partnerTopicRoutingMode: observed.properties?.partnerTopicRoutingMode ?? "SourceEventAttribute",
  endpoint: observed.properties?.endpoint,
  ...redactKeys(keys),
  tags: userTags(observed.tags),
});

const provisioned = (namespace: ObservedNamespace) => namespace.properties?.provisioningState;

export const PartnerNamespaceProvider = () =>
  Provider.succeed(PartnerNamespace, {
    stables: [
      "partnerNamespaceName",
      "partnerNamespaceId",
      "resourceGroup",
      "location",
      "partnerRegistration",
      "partnerTopicRoutingMode",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventgrid
        .ListPartnerNamespaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListPartnerNamespaceBySubscription", page)),
        );
      return (page.value ?? []).flatMap((namespace) => {
        const group = resourceGroupOf(namespace.id);
        return hasAnyAlchemyTag(namespace.tags) &&
          group !== undefined &&
          namespace.name !== undefined
          ? [toAttrs(group, namespace.name, namespace, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.partnerNamespaceName) ||
        (news.location !== undefined && !sameName(news.location, output.location)) ||
        !sameName(news.partnerRegistration, output.partnerRegistration) ||
        (news.partnerTopicRoutingMode ?? "SourceEventAttribute") !== output.partnerTopicRoutingMode
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
        output?.partnerNamespaceName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getNamespace(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth,
      );
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.EventGrid");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.partnerNamespaceName ?? (yield* createEventGridName(id, 50));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const inboundIpRules = toIpRules(news.inboundIpRules);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        partnerNamespaceName: name,
      };
      const get = getNamespace(subscriptionId, resourceGroup, name);
      const label = `event grid partner namespace ${name}`;

      // PUT body: desired settings, with unset ones kept as observed.
      const put = (current: eventgrid.PartnerNamespaceProperties | undefined) =>
        eventgrid.PartnerNamespacesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            partnerRegistrationFullyQualifiedId: news.partnerRegistration,
            partnerTopicRoutingMode: news.partnerTopicRoutingMode ?? "SourceEventAttribute",
            publicNetworkAccess: news.publicNetworkAccess ?? current?.publicNetworkAccess,
            inboundIpRules,
            minimumTlsVersionAllowed:
              news.minimumTlsVersionAllowed ?? current?.minimumTlsVersionAllowed,
            disableLocalAuth: news.disableLocalAuth ?? current?.disableLocalAuth,
          },
        });

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; channels can only be
      // created once the namespace is `Succeeded` and has an endpoint.
      if (observed === undefined) {
        yield* put(undefined);
      }
      observed = yield* waitForProvisioned(label, get, provisioned, { times: 60 });

      // Sync against observed state. PATCH accepts the network settings but
      // silently ignores them (only tags apply), so a property change is a
      // full PUT of the desired body; a tag-only change is a PATCH.
      const props = observed.properties ?? {};
      const changed: Partial<eventgrid.PartnerNamespaceUpdateParameterProperties> = {};
      setIfChanged(
        changed,
        "publicNetworkAccess",
        news.publicNetworkAccess,
        props.publicNetworkAccess,
      );
      setIfChanged(
        changed,
        "minimumTlsVersionAllowed",
        news.minimumTlsVersionAllowed,
        props.minimumTlsVersionAllowed,
      );
      setIfChanged(
        changed,
        "disableLocalAuth",
        news.disableLocalAuth,
        props.disableLocalAuth ?? false,
      );
      if (ipRulesDiffer(props.inboundIpRules, inboundIpRules)) {
        changed.inboundIpRules = inboundIpRules;
      }
      if (Object.keys(changed).length > 0) {
        yield* put(props);
        observed = yield* waitForProvisioned(label, get, provisioned, { times: 60 });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* eventgrid.UpdatePartnerNamespace({ ...where, tags });
        observed = yield* waitForProvisioned(label, get, provisioned, { times: 60 });
      }

      const keys = yield* listKeys(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.disableLocalAuth,
      );
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        eventgrid.DeletePartnerNamespace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          partnerNamespaceName: output.partnerNamespaceName,
        }),
      );
      yield* waitUntilGone(
        `event grid partner namespace ${output.partnerNamespaceName}`,
        getNamespace(subscriptionId, output.resourceGroup, output.partnerNamespaceName),
        { times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.EventGrid.PartnerRegistration", "Azure.Resources.ResourceGroup"],
    },
  });
