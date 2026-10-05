import * as datadog from "@distilled.cloud/azure/datadog";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { canonicalJson, getMonitor, sameName } from "./common.ts";

/** The Datadog organization owner Datadog contacts about the monitor. */
export interface DatadogUserInfo {
  /** Email address of the user (required). */
  emailAddress: string;
  /** Full name of the user. */
  name?: string;
  /** Phone number of the user. */
  phoneNumber?: string;
}

/**
 * The Datadog organization behind the monitor. Omit everything to create a
 * new organization; set `linkingAuthCode` + `linkingClientId` (or `id`,
 * `apiKey`, and `applicationKey`) to link an existing one.
 */
export interface DatadogOrganization {
  /**
   * Name of the Datadog organization. A new organization needs one.
   * @default the monitor name when creating a new organization
   */
  name?: string;
  /** ID of an existing Datadog organization to link. */
  id?: string;
  /** OAuth auth code from Datadog used to link an existing organization. */
  linkingAuthCode?: Redacted.Redacted<string>;
  /** OAuth client ID that issued `linkingAuthCode`. */
  linkingClientId?: string;
  /** Redirect URI used when obtaining `linkingAuthCode`. */
  redirectUri?: string;
  /** API key of the existing Datadog organization. */
  apiKey?: Redacted.Redacted<string>;
  /** Application key of the existing Datadog organization. */
  applicationKey?: Redacted.Redacted<string>;
  /** ID of the Entra ID enterprise application used for SAML single sign-on. */
  enterpriseAppId?: string;
}

export interface MonitorProps {
  /**
   * Resource group the monitor is created in. Changing it replaces the
   * monitor.
   */
  resourceGroup: string;
  /**
   * Name of the monitor resource, 2-32 letters, digits, `-`, and `_`. If
   * omitted, a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the monitor.
   */
  name?: string;
  /**
   * Azure location of the monitor. Datadog monitors are offered in a few
   * regions only (e.g. `westus2`). Changing it replaces the monitor.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Azure Marketplace plan ID of the Datadog subscription, e.g.
   * `payg_v3_Monthly`, or `Linked` when linking an existing organization.
   * Changing it replaces the monitor.
   * @default "payg_v3_Monthly"
   */
  sku?: string;
  /**
   * The Datadog organization owner. Changing it replaces the monitor.
   */
  userInfo: DatadogUserInfo;
  /**
   * The Datadog organization to create or link. Changing it replaces the
   * monitor.
   */
  organization?: DatadogOrganization;
  /**
   * Whether the monitor gets a system-assigned managed identity, which
   * Datadog uses to read metrics (grant it Monitoring Reader). Changing it
   * replaces the monitor.
   * @default true
   */
  systemAssignedIdentity?: boolean;
  /**
   * Whether Azure resources are monitored.
   * @default "Enabled"
   */
  monitoringStatus?: "Enabled" | "Disabled";
  /**
   * Collect resource configuration for Datadog Cloud Security Posture
   * Management.
   */
  cspm?: boolean;
  /**
   * Collect configuration information for every resource in the
   * subscription.
   */
  resourceCollection?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Monitor extends Resource<
  "Azure.Datadog.Monitor",
  MonitorProps,
  {
    /** Name of the monitor resource. */
    monitorName: string;
    /** Resource group that holds the monitor. */
    resourceGroup: string;
    /** ARM resource ID of the monitor. */
    monitorId: string;
    /** Location of the monitor. */
    location: string;
    /** Marketplace plan ID of the monitor. */
    sku: string | undefined;
    /** ID of the Datadog organization. */
    datadogOrganizationId: string | undefined;
    /** Name of the Datadog organization. */
    datadogOrganizationName: string | undefined;
    /** Status of the Marketplace SaaS subscription, e.g. `Active`. */
    marketplaceSubscriptionStatus: string | undefined;
    /** Whether Azure resources are monitored. */
    monitoringStatus: string | undefined;
    /** Liftr resource category, e.g. `MonitorLogs`. */
    liftrResourceCategory: string | undefined;
    /** Principal ID of the system-assigned managed identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Datadog monitor provisioned as an Azure Native ISV Service
 * (`Microsoft.Datadog/monitors`). It creates (or links) a Datadog
 * organization, subscribes to a Datadog plan through Azure Marketplace, and
 * streams Azure metrics and logs to Datadog. Deleting it cancels the SaaS
 * subscription unless the organization was linked.
 *
 * The subscription must allow Marketplace purchases (free trial and
 * sponsored subscriptions cannot) and have accepted the Datadog
 * Marketplace terms. Creating a new organization is a Marketplace SaaS
 * purchase that Datadog rejects for service-principal callers
 * (`DatadogMonitorCreationFailed`); deploy it signed in as a user, or link
 * an existing organization with `sku: "Linked"`. Tag rules, single
 * sign-on, and monitored subscriptions are managed as children of the
 * monitor.
 *
 * @see https://learn.microsoft.com/azure/partner-solutions/datadog/overview
 *
 * ### Creating a Monitor
 * **Example:** Pay-as-you-go Datadog organization
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("observability", {
 *   location: "westus2",
 * });
 * const monitor = yield* Azure.Datadog.Monitor("datadog", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   userInfo: { name: "Platform Team", emailAddress: "platform@example.com" },
 * });
 * ```
 *
 * **Example:** Linking an existing Datadog organization
 * ```typescript
 * const monitor = yield* Azure.Datadog.Monitor("datadog", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   sku: "Linked",
 *   userInfo: { emailAddress: "platform@example.com" },
 *   organization: {
 *     linkingAuthCode: Redacted.make(process.env.DATADOG_LINKING_CODE!),
 *     linkingClientId: process.env.DATADOG_CLIENT_ID!,
 *   },
 * });
 * ```
 *
 * ### Pausing Monitoring
 * **Example:** Disable monitoring without deleting the organization
 * ```typescript
 * const monitor = yield* Azure.Datadog.Monitor("datadog", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   userInfo: { emailAddress: "platform@example.com" },
 *   monitoringStatus: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Monitor = Resource<Monitor>("Azure.Datadog.Monitor");

type ObservedMonitor = datadog.GetMonitorResponse;

const DEFAULT_SKU = "payg_v3_Monthly";

const createMonitorName = (id: string) =>
  createPhysicalName({ id, maxLength: 32 });

const reveal = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);

/** Create-only organization fields, with secrets revealed for comparison. */
const organizationIdentity = (org: DatadogOrganization | undefined) => ({
  name: org?.name,
  id: org?.id,
  linkingAuthCode: reveal(org?.linkingAuthCode),
  linkingClientId: org?.linkingClientId,
  redirectUri: org?.redirectUri,
  apiKey: reveal(org?.apiKey),
  applicationKey: reveal(org?.applicationKey),
  enterpriseAppId: org?.enterpriseAppId,
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedMonitor,
): Monitor["Attributes"] => ({
  monitorName: name,
  resourceGroup,
  monitorId: observed.id ?? "",
  location: observed.location,
  sku: observed.sku?.name,
  datadogOrganizationId: observed.properties?.datadogOrganizationProperties?.id,
  datadogOrganizationName:
    observed.properties?.datadogOrganizationProperties?.name,
  marketplaceSubscriptionStatus:
    observed.properties?.marketplaceSubscriptionStatus,
  monitoringStatus: observed.properties?.monitoringStatus,
  liftrResourceCategory: observed.properties?.liftrResourceCategory,
  principalId: observed.identity?.principalId,
  tags: userTags(observed.tags),
});

const waitForMonitor = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `Datadog monitor ${name}`,
    getMonitor(subscriptionId, resourceGroup, name),
    (monitor) => monitor.properties?.provisioningState,
    { interval: "10 seconds", times: 60 },
  );

export const MonitorProvider = () =>
  Provider.succeed(Monitor, {
    stables: ["monitorName", "resourceGroup", "monitorId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* datadog
        .ListMonitors({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListMonitors", page)),
        );
      return (page.value ?? []).flatMap((monitor) => {
        const group = resourceGroupOf(monitor.id);
        return hasAnyAlchemyTag(monitor.tags) &&
          group !== undefined &&
          monitor.name !== undefined
          ? [toAttrs(group, monitor.name, monitor)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.monitorName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        (output.sku !== undefined &&
          !sameName(news.sku ?? DEFAULT_SKU, output.sku))
      ) {
        return { action: "replace" } as const;
      }
      if (
        output.principalId !== undefined &&
        (news.systemAssignedIdentity ?? true) === false
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        if (
          canonicalJson(olds.userInfo) !== canonicalJson(news.userInfo) ||
          canonicalJson(organizationIdentity(olds.organization)) !==
            canonicalJson(organizationIdentity(news.organization)) ||
          (olds.systemAssignedIdentity ?? true) !==
            (news.systemAssignedIdentity ?? true)
        ) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.monitorName ?? olds?.name ?? (yield* createMonitorName(id));
      const observed = yield* getMonitor(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Datadog");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.monitorName ?? (yield* createMonitorName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const monitoringStatus = news.monitoringStatus ?? "Enabled";

      // Observe.
      let observed = yield* getMonitor(subscriptionId, resourceGroup, name);

      // Ensure: the PUT subscribes to the Marketplace plan and provisions
      // (or links) the Datadog organization in the background.
      if (observed === undefined) {
        const org = organizationIdentity(news.organization);
        // A new organization needs a name (Datadog rejects the PUT with
        // `ResourceCreationValidateFailed` otherwise); linking does not.
        const linking =
          org.id !== undefined ||
          org.linkingAuthCode !== undefined ||
          org.apiKey !== undefined;
        if (!linking && org.name === undefined) org.name = name;
        yield* datadog.CreateMonitor({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: name,
          location,
          tags,
          sku: { name: news.sku ?? DEFAULT_SKU },
          identity:
            (news.systemAssignedIdentity ?? true)
              ? { type: "SystemAssigned" }
              : undefined,
          properties: {
            monitoringStatus,
            userInfo: news.userInfo,
            datadogOrganizationProperties: {
              ...org,
              cspm: news.cspm,
              resourceCollection: news.resourceCollection,
            },
          },
        });
      }
      observed = yield* waitForMonitor(subscriptionId, resourceGroup, name);

      // Sync the mutable aspects against the observed monitor.
      const observedOrg = observed.properties?.datadogOrganizationProperties;
      const properties: datadog.MonitorUpdateProperties = {};
      if (observed.properties?.monitoringStatus !== monitoringStatus) {
        properties.monitoringStatus = monitoringStatus;
      }
      if (news.cspm !== undefined && observedOrg?.cspm !== news.cspm) {
        properties.cspm = news.cspm;
      }
      if (
        news.resourceCollection !== undefined &&
        observedOrg?.resourceCollection !== news.resourceCollection
      ) {
        properties.resourceCollection = news.resourceCollection;
      }
      const syncTags = tagsDiffer(observed.tags, tags);
      if (Object.keys(properties).length > 0 || syncTags) {
        yield* datadog.UpdateMonitor({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: name,
          properties:
            Object.keys(properties).length > 0 ? properties : undefined,
          tags: syncTags ? tags : undefined,
        });
        observed = yield* waitForMonitor(subscriptionId, resourceGroup, name);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datadog.DeleteMonitor({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitorName,
        }),
      );
      yield* waitUntilGone(
        `Datadog monitor ${output.monitorName}`,
        getMonitor(subscriptionId, output.resourceGroup, output.monitorName),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
