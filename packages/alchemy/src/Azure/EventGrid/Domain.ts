import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import type { EventGridInputSchema, JsonInputSchemaMapping } from "./Topic.ts";
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

export interface DomainProps {
  /** Resource group the domain is created in. Changing it replaces the domain. */
  resourceGroup: string;
  /**
   * Domain name: 3-50 letters, digits, and hyphens, unique per region. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the domain.
   */
  name?: string;
  /**
   * Azure location of the domain. Changing it replaces the domain.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Schema of published events. Immutable: changing it replaces the domain.
   * @default "EventGridSchema"
   */
  inputSchema?: EventGridInputSchema;
  /**
   * Field mappings used with `inputSchema: "CustomEventSchema"`. Changing
   * it replaces the domain.
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
  /** Managed identity of the domain, used for identity-based delivery. */
  identity?: EventGridIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
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
 * An Event Grid domain — one publish endpoint that multiplexes many domain
 * topics, e.g. one topic per tenant of a multi-tenant application.
 *
 * @see https://learn.microsoft.com/azure/event-grid/event-domains
 *
 * ### Creating a Domain
 * **Example:** Domain with default settings
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const domain = yield* Azure.EventGrid.Domain("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Domain whose topics are managed explicitly
 * ```typescript
 * const domain = yield* Azure.EventGrid.Domain("tenants", {
 *   resourceGroup: group.resourceGroupName,
 *   autoCreateTopicWithFirstSubscription: false,
 *   autoDeleteTopicWithLastSubscription: false,
 * });
 * const contoso = yield* Azure.EventGrid.DomainTopic("contoso", {
 *   resourceGroup: group.resourceGroupName,
 *   domain: domain.domainName,
 * });
 * ```
 *
 * @resource
 */
export const Domain = Resource<Domain>("Azure.EventGrid.Domain");

const getDomain = (
  subscriptionId: string,
  resourceGroupName: string,
  domainName: string,
) =>
  orUndefinedIfNotFound(
    eventgrid.GetDomain({ subscriptionId, resourceGroupName, domainName }),
  );

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
  autoCreateTopicWithFirstSubscription:
    domain.properties?.autoCreateTopicWithFirstSubscription,
  autoDeleteTopicWithLastSubscription:
    domain.properties?.autoDeleteTopicWithLastSubscription,
  inputSchema: domain.properties?.inputSchema ?? "EventGridSchema",
  principalId: domain.identity?.principalId,
  ...redactKeys(keys),
  tags: userTags(domain.tags),
});

const provisioned = (domain: ObservedDomain) =>
  domain.properties?.provisioningState;

export const DomainProvider = () =>
  Provider.succeed(Domain, {
    stables: ["domainName", "domainId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* eventgrid
        .ListDomainBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDomainBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((domain) => {
        const group = resourceGroupOf(domain.id);
        return hasAnyAlchemyTag(domain.tags) &&
          group !== undefined &&
          domain.name !== undefined
          ? [toAttrs(group, domain.name, domain, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.domainName) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
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
      const name =
        output?.domainName ??
        olds?.name ??
        (yield* createEventGridName(id, 50));
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
      const name =
        news.name ?? output?.domainName ?? (yield* createEventGridName(id, 50));
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
            autoCreateTopicWithFirstSubscription:
              news.autoCreateTopicWithFirstSubscription,
            autoDeleteTopicWithLastSubscription:
              news.autoDeleteTopicWithLastSubscription,
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
