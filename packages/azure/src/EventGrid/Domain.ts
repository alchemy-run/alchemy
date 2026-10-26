import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
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
  identityDiffers,
  ipRulesDiffer,
  redactKeys,
  sameName,
  setIfChanged,
  toIdentityInfo,
  toInputSchemaMapping,
  toIpRules,
  type EventGridIdentity,
  type EventGridInboundIpRule,
} from "./common.ts";
import type { EventGridInputSchema, JsonInputSchemaMapping } from "./Topic.ts";

export interface DomainProps {
  /**
   * Resource group the domain is created in.
   *
   * :::caution
   * Changing it replaces the domain.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Domain name: 3-50 letters, digits, and hyphens, unique per region. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the domain.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the domain.
   *
   * :::caution
   * Changing it replaces the domain.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Schema of published events: `EventGridSchema`, `CloudEventSchemaV1_0`,
   * or `CustomEventSchema` (with `inputSchemaMapping`).
   *
   * :::caution
   * Changing it replaces the domain.
   * :::
   * @default "EventGridSchema"
   */
  inputSchema?: EventGridInputSchema;
  /**
   * Field mappings used with `inputSchema: "CustomEventSchema"`.
   *
   * :::caution
   * Changing it replaces the domain.
   * :::
   * @default no mapping
   */
  inputSchemaMapping?: JsonInputSchemaMapping;
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
   * @default Azure's default (`1.2`)
   */
  minimumTlsVersionAllowed?: "1.0" | "1.1" | "1.2";
  /**
   * Require Microsoft Entra ID to publish (disables SAS keys). When `true`,
   * `primaryKey`/`secondaryKey` are not returned.
   * @default Azure's default (`false`)
   */
  disableLocalAuth?: boolean;
  /**
   * Data residency boundary of the domain.
   * @default Azure's default
   */
  dataResidencyBoundary?: "WithinGeopair" | "WithinRegion";
  /**
   * Create a domain topic automatically when the first event subscription
   * for it is created.
   * @default Azure's default (`true`)
   */
  autoCreateTopicWithFirstSubscription?: boolean;
  /**
   * Delete a domain topic automatically when its last event subscription
   * is deleted. This also removes explicitly created `DomainTopic`s.
   * @default Azure's default (`true`)
   */
  autoDeleteTopicWithLastSubscription?: boolean;
  /**
   * Managed identity of the domain, used for identity-based delivery
   * (`deliveryIdentity` on an event subscription).
   * @default the observed identity is kept (none on a new domain)
   */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Domain extends Resource<
  "Azure.EventGrid.Domain",
  DomainProps,
  {
    /** Name of the domain. */
    domainName: string;
    /** ARM resource ID of the domain; use it as an event-subscription scope. */
    domainId: string;
    /** Resource group that holds the domain. */
    resourceGroup: string;
    /** Location of the domain. */
    location: string;
    /** Publish endpoint, e.g. `https://{name}.eastus-1.eventgrid.azure.net/api/events`. */
    endpoint: string | undefined;
    /** Metric resource ID of the domain. */
    metricResourceId: string | undefined;
    /** Whether domain topics are created with their first subscription. */
    autoCreateTopicWithFirstSubscription: boolean | undefined;
    /** Whether domain topics are deleted with their last subscription. */
    autoDeleteTopicWithLastSubscription: boolean | undefined;
    /** Schema of published events. */
    inputSchema: string;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
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
 * An Event Grid domain (`Microsoft.EventGrid/domains`): one publish
 * endpoint for many domain topics, for example one topic per tenant of a
 * multi-tenant application. Publishers set each event's `topic` field to
 * route it; each tenant subscribes to its own domain topic.
 *
 * Alchemy creates the domain in the stack's resource group with the Event
 * Grid schema. Publishers outside Azure use the SAS keys (`Redacted`
 * attributes) or Microsoft Entra ID with **EventGrid Data Sender** on the
 * domain.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `inputSchema`, or `inputSchemaMapping` replaces the domain]
 * Alchemy creates a new domain with a new endpoint and keys, and deletes the
 * old one with every domain topic and event subscription in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/event-grid/event-domains
 *
 * ### Creating a Domain
 * **Example:** Domain with default settings
 * ```typescript
 * const tenants = yield* Azure.EventGrid.Domain("tenants");
 * // tenants.endpoint → "https://<name>.<region>-1.eventgrid.azure.net/api/events"
 * ```
 *
 * **Example:** CloudEvents domain
 * ```typescript
 * const tenants = yield* Azure.EventGrid.Domain("tenants", {
 *   inputSchema: "CloudEventSchemaV1_0",
 * });
 * ```
 *
 * ### Domain Topics
 * By default, Azure creates a domain topic with its first event
 * subscription and deletes it with its last one. Turn both off to manage
 * the topics yourself.
 *
 * **Example:** Declare each tenant's topic
 * ```typescript
 * const tenants = yield* Azure.EventGrid.Domain("tenants", {
 *   autoCreateTopicWithFirstSubscription: false,
 *   autoDeleteTopicWithLastSubscription: false,
 * });
 * const contoso = yield* Azure.EventGrid.DomainTopic("contoso", {
 *   domain: tenants.domainName,
 *   name: "contoso",
 * });
 * ```
 *
 * ### Subscribing
 * **Example:** Deliver one tenant's events to its queue
 * ```typescript
 * yield* Azure.EventGrid.DomainTopicEventSubscription("contoso-to-queue", {
 *   domain: tenants.domainName,
 *   domainTopic: contoso.domainTopicName,
 *   destination: { endpointType: "ServiceBusQueue", resourceId: contosoQueue.queueId },
 * });
 * ```
 *
 * **Example:** Receive every tenant's events
 * ```typescript
 * yield* Azure.EventGrid.DomainEventSubscription("all-tenants-audit", {
 *   domain: tenants.domainName,
 *   destination: { endpointType: "EventHub", resourceId: audit.eventHubId },
 * });
 * ```
 *
 * ### Authentication and Network Access
 * **Example:** Accept Microsoft Entra ID only, from one IP range
 * ```typescript
 * const tenants = yield* Azure.EventGrid.Domain("tenants", {
 *   disableLocalAuth: true,
 *   inboundIpRules: [{ ipMask: "203.0.113.0/24" }],
 * });
 * ```
 *
 * **Example:** Let a publisher identity send events
 * ```typescript
 * const publisher = yield* Azure.ManagedIdentity.UserAssignedIdentity("publisher");
 * yield* Azure.Authorization.RoleAssignment("publisher-sends", {
 *   scope: tenants.domainId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.EventGridDataSender,
 *   principalId: publisher.principalId,
 * });
 * ```
 *
 * ### Delivering with a Managed Identity
 * **Example:** Deliver to Service Bus with the domain's identity
 * ```typescript
 * const tenants = yield* Azure.EventGrid.Domain("tenants", {
 *   identity: { type: "SystemAssigned" },
 * });
 * yield* Azure.Authorization.RoleAssignment("tenants-sender", {
 *   scope: contosoQueue.queueId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.ServiceBusDataSender,
 *   principalId: tenants.principalId.as<string>(),
 * });
 * yield* Azure.EventGrid.DomainTopicEventSubscription("contoso-to-queue", {
 *   domain: tenants.domainName,
 *   domainTopic: contoso.domainTopicName,
 *   destination: { endpointType: "ServiceBusQueue", resourceId: contosoQueue.queueId },
 *   deliveryIdentity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * ### Event Sources
 * **Example:** Handle one tenant's events in an Azure Function
 * ```typescript
 * export default class Contoso extends Azure.Functions.Function<Contoso>()(
 *   "Contoso",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const topic = yield* ContosoTopic;
 *     yield* Azure.EventGrid.consumeEvents(
 *       "ContosoEvents",
 *       { scope: topic.domainTopicId },
 *       (event) => Effect.log(`${event.eventType} ${event.subject}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Azure.Functions.EventGridEventSource)),
 * ) {}
 * ```
 *
 * @resource
 */
export const Domain = GroupedResource<Domain>("Azure.EventGrid.Domain");

const getDomain = (subscriptionId: string, resourceGroupName: string, domainName: string) =>
  orUndefinedIfNotFound(eventgrid.GetDomain({ subscriptionId, resourceGroupName, domainName }));

const listKeys = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
  disableLocalAuth: boolean | undefined,
) =>
  disableLocalAuth
    ? Effect.succeed(undefined)
    : orUndefinedIfNotFound(
        eventgrid.ListDomainSharedAccessKeys({
          subscriptionId,
          resourceGroupName,
          domainName,
        }),
      );

type ObservedDomain = Pick<
  eventgrid.Domain,
  "id" | "location" | "properties" | "identity" | "tags"
>;

const toAttrs = (
  resourceGroup: string,
  name: string,
  domain: ObservedDomain,
  keys: { key1?: string; key2?: string } | undefined,
): Domain["Attributes"] => ({
  domainName: name,
  domainId: domain.id ?? "",
  resourceGroup,
  location: domain.location,
  endpoint: domain.properties?.endpoint,
  metricResourceId: domain.properties?.metricResourceId,
  autoCreateTopicWithFirstSubscription: domain.properties?.autoCreateTopicWithFirstSubscription,
  autoDeleteTopicWithLastSubscription: domain.properties?.autoDeleteTopicWithLastSubscription,
  inputSchema: domain.properties?.inputSchema ?? "EventGridSchema",
  principalId: domain.identity?.principalId,
  ...redactKeys(keys),
  tags: userTags(domain.tags),
});

const provisioned = (domain: ObservedDomain) => domain.properties?.provisioningState;

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["domainName", "domainId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(eventgrid.ListDomainBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((domain) => {
        const group = resourceGroupOf(domain.id);
        return hasAnyAlchemyTag(domain.tags) && group !== undefined && domain.name !== undefined
          ? [toAttrs(group, domain.name, domain, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.domainName) ||
        (news.location !== undefined && !sameName(news.location, output.location)) ||
        (news.inputSchema ?? "EventGridSchema") !== output.inputSchema ||
        JSON.stringify(news.inputSchemaMapping ?? null) !==
          JSON.stringify(olds?.inputSchemaMapping ?? null)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.domainName ?? olds?.name ?? (yield* createEventGridName(id, 50));
      const observed = yield* getDomain(subscriptionId, resourceGroup, name);
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
      const name = news.name ?? output?.domainName ?? (yield* createEventGridName(id, 50));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = toIdentityInfo(news.identity);
      const inboundIpRules = toIpRules(news.inboundIpRules);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        domainName: name,
      };
      const get = getDomain(subscriptionId, resourceGroup, name);
      const label = `event grid domain ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; poll until provisioned.
      if (observed === undefined) {
        yield* eventgrid.DomainsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            inputSchema: news.inputSchema ?? "EventGridSchema",
            inputSchemaMapping: toInputSchemaMapping(news.inputSchemaMapping),
            publicNetworkAccess: news.publicNetworkAccess,
            inboundIpRules,
            minimumTlsVersionAllowed: news.minimumTlsVersionAllowed,
            disableLocalAuth: news.disableLocalAuth,
            dataResidencyBoundary: news.dataResidencyBoundary,
            autoCreateTopicWithFirstSubscription: news.autoCreateTopicWithFirstSubscription,
            autoDeleteTopicWithLastSubscription: news.autoDeleteTopicWithLastSubscription,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, provisioned, {
        times: 60,
      });

      // Sync mutable aspects against observed state; PATCH only the delta.
      const props = observed.properties ?? {};
      const changed: eventgrid.DomainUpdateParameterProperties = {};
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
      setIfChanged(
        changed,
        "dataResidencyBoundary",
        news.dataResidencyBoundary,
        props.dataResidencyBoundary,
      );
      setIfChanged(
        changed,
        "autoCreateTopicWithFirstSubscription",
        news.autoCreateTopicWithFirstSubscription,
        props.autoCreateTopicWithFirstSubscription,
      );
      setIfChanged(
        changed,
        "autoDeleteTopicWithLastSubscription",
        news.autoDeleteTopicWithLastSubscription,
        props.autoDeleteTopicWithLastSubscription,
      );
      if (ipRulesDiffer(props.inboundIpRules, inboundIpRules)) {
        changed.inboundIpRules = inboundIpRules;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      if (Object.keys(changed).length > 0 || tagsChanged || identityChanged) {
        yield* eventgrid.UpdateDomain({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged ? identity : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(label, get, provisioned, {
          times: 60,
        });
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
        eventgrid.DeleteDomain({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          domainName: output.domainName,
        }),
      );
      yield* waitUntilGone(
        `event grid domain ${output.domainName}`,
        getDomain(subscriptionId, output.resourceGroup, output.domainName),
        { times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
