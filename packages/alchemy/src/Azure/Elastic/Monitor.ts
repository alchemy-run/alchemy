import * as elastic from "@distilled.cloud/azure/elastic";
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

/** Company details Elastic uses to provision the Elastic Cloud organization. */
export interface ElasticCompanyInfo {
  /** Domain of the company, e.g. `example.com`. */
  domain?: string;
  /** Business of the company. */
  business?: string;
  /** Number of employees, e.g. `1-10`. */
  employeesNumber?: string;
  /** State of the company location. */
  state?: string;
  /** Country of the company location. */
  country?: string;
}

/** The Elastic Cloud organization owner. */
export interface ElasticUserInfo {
  /** Email address Elastic uses to contact the owner (required). */
  emailAddress: string;
  /** First name of the owner. */
  firstName?: string;
  /** Last name of the owner. */
  lastName?: string;
  /** Company name of the owner. */
  companyName?: string;
  /** Company details. */
  companyInfo?: ElasticCompanyInfo;
}

/** The Azure Marketplace plan the monitor subscribes to. */
export interface ElasticPlanDetails {
  /** Marketplace offer ID, e.g. `ec-azure-pp`. */
  offerID?: string;
  /** Marketplace publisher ID, e.g. `elastic`. */
  publisherID?: string;
  /** Billing term ID. */
  termID?: string;
  /** Marketplace plan ID, e.g. `ess-consumption-2024`. */
  planID?: string;
  /** Display name of the plan. */
  planName?: string;
}

export interface MonitorProps {
  /**
   * Resource group the monitor is created in. Changing it replaces the
   * monitor.
   */
  resourceGroup: string;
  /**
   * Name of the monitor resource (at most 32 characters). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the monitor.
   */
  name?: string;
  /**
   * Azure location of the monitor. Changing it replaces the monitor.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Azure Marketplace SKU (plan + billing term) of the Elastic Cloud
   * subscription. Changing it replaces the monitor.
   * @default "ess-consumption-2024_Monthly"
   */
  sku?: string;
  /**
   * The kind of Elastic resource, e.g. observability, security, or search.
   * Changing it replaces the monitor.
   */
  kind?: string;
  /** The Elastic Cloud organization owner. Changing it replaces the monitor. */
  userInfo: ElasticUserInfo;
  /**
   * Marketplace plan details. Changing them replaces the monitor.
   */
  planDetails?: ElasticPlanDetails;
  /**
   * Elastic Stack version of the deployment, e.g. `8.15.0`. Changing it
   * replaces the monitor.
   */
  version?: string;
  /**
   * Whether the monitor creates a hosted deployment or a serverless
   * project. Changing it replaces the monitor.
   * @default "Hosted"
   */
  hostingType?: "Hosted" | "Serverless";
  /**
   * Serverless project details (only for `hostingType: "Serverless"`).
   * Changing them replaces the monitor.
   */
  projectDetails?: {
    /** Project type. */
    projectType?: "Elasticsearch" | "Observability" | "Security";
    /** Configuration type of an Elasticsearch project. */
    configurationType?: "GeneralPurpose" | "Vector" | "TimeSeries";
  };
  /**
   * Generate an Elastic organization API key during creation. Create-only.
   * @default false
   */
  generateApiKey?: boolean;
  /**
   * Whether Azure resources are monitored. The service cannot change it in
   * place, so changing it replaces the monitor.
   * @default "Enabled"
   */
  monitoringStatus?: "Enabled" | "Disabled";
  /**
   * Whether the monitor gets a system-assigned managed identity. ARM
   * currently rejects it for `Microsoft.Elastic/monitors` ("does not support
   * creation of 'SystemAssigned' resource identity"), so leave it off unless
   * your region supports it. Changing it replaces the monitor.
   * @default false
   */
  systemAssignedIdentity?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Monitor extends Resource<
  "Azure.Elastic.Monitor",
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
    /** Marketplace SKU of the monitor. */
    sku: string | undefined;
    /** Whether Azure resources are monitored. */
    monitoringStatus: string | undefined;
    /** Hosting type, `Hosted` or `Serverless`. */
    hostingType: string | undefined;
    /** Elastic Stack version. */
    version: string | undefined;
    /** ID of the Elastic Cloud deployment. */
    deploymentId: string | undefined;
    /** Elasticsearch ingestion endpoint of the deployment. */
    elasticsearchServiceUrl: string | undefined;
    /** Kibana endpoint of the deployment. */
    kibanaServiceUrl: string | undefined;
    /** Kibana single sign-on URL of the deployment. */
    kibanaSsoUrl: string | undefined;
    /** Elastic Cloud default single sign-on URL of the owner. */
    elasticCloudSsoDefaultUrl: string | undefined;
    /** Category of the monitor, e.g. `MonitorLogs`. */
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
 * An Elastic Cloud (Elasticsearch) monitor provisioned as an Azure Native
 * ISV Service (`Microsoft.Elastic/monitors`). It subscribes to an Elastic
 * Cloud plan through Azure Marketplace, creates an Elastic Cloud
 * deployment (or serverless project), and streams Azure logs to it.
 * Deleting it deletes the deployment and cancels the SaaS subscription.
 *
 * The subscription must allow Marketplace purchases (free trial and
 * sponsored subscriptions cannot). Tag rules, monitored subscriptions, and
 * OpenAI integrations are managed as children of the monitor.
 *
 * @see https://learn.microsoft.com/azure/partner-solutions/elastic/overview
 *
 * ### Creating a Monitor
 * **Example:** Pay-as-you-go hosted Elastic deployment
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("observability", {
 *   location: "westus2",
 * });
 * const monitor = yield* Azure.Elastic.Monitor("elastic", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   userInfo: {
 *     emailAddress: "platform@example.com",
 *     firstName: "Platform",
 *     lastName: "Team",
 *     companyName: "Example",
 *   },
 * });
 * ```
 *
 * **Example:** Serverless observability project
 * ```typescript
 * const monitor = yield* Azure.Elastic.Monitor("elastic", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   userInfo: { emailAddress: "platform@example.com" },
 *   hostingType: "Serverless",
 *   projectDetails: { projectType: "Observability" },
 * });
 * ```
 *
 * ### Using the Deployment
 * **Example:** Expose the Kibana and Elasticsearch endpoints
 * ```typescript
 * return {
 *   kibana: monitor.kibanaServiceUrl,
 *   elasticsearch: monitor.elasticsearchServiceUrl,
 * };
 * ```
 *
 * @resource
 */
export const Monitor = Resource<Monitor>("Azure.Elastic.Monitor");

type ObservedMonitor = elastic.GetMonitorResponse;

export const DEFAULT_ELASTIC_SKU = "ess-consumption-2024_Monthly";

const createMonitorName = (id: string) =>
  createPhysicalName({ id, maxLength: 32 });

/** Create-only props whose change replaces the monitor. */
const createOnly = (props: MonitorProps) => ({
  kind: props.kind,
  userInfo: props.userInfo,
  planDetails: props.planDetails,
  version: props.version,
  hostingType: props.hostingType ?? "Hosted",
  projectDetails: props.projectDetails,
  systemAssignedIdentity: props.systemAssignedIdentity ?? false,
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedMonitor,
): Monitor["Attributes"] => {
  const deployment =
    observed.properties?.elasticProperties?.elasticCloudDeployment;
  return {
    monitorName: name,
    resourceGroup,
    monitorId: observed.id ?? "",
    location: observed.location,
    sku: observed.sku?.name,
    monitoringStatus: observed.properties?.monitoringStatus,
    hostingType: observed.properties?.hostingType,
    version: observed.properties?.version,
    deploymentId: deployment?.deploymentId,
    elasticsearchServiceUrl: deployment?.elasticsearchServiceUrl,
    kibanaServiceUrl: deployment?.kibanaServiceUrl,
    kibanaSsoUrl: deployment?.kibanaSsoUrl,
    elasticCloudSsoDefaultUrl:
      observed.properties?.elasticProperties?.elasticCloudUser
        ?.elasticCloudSsoDefaultUrl,
    liftrResourceCategory: observed.properties?.liftrResourceCategory,
    principalId: observed.identity?.principalId,
    tags: userTags(observed.tags),
  };
};

const waitForMonitor = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `Elastic monitor ${name}`,
    getMonitor(subscriptionId, resourceGroup, name),
    (monitor) => monitor.properties?.provisioningState,
    { interval: "15 seconds", times: 60 },
  );

export const MonitorProvider = () =>
  Provider.succeed(Monitor, {
    stables: ["monitorName", "resourceGroup", "monitorId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* elastic
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
          !sameName(news.sku ?? DEFAULT_ELASTIC_SKU, output.sku)) ||
        (output.monitoringStatus !== undefined &&
          (news.monitoringStatus ?? "Enabled") !== output.monitoringStatus)
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        canonicalJson(createOnly(olds)) !== canonicalJson(createOnly(news))
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
        output?.monitorName ?? olds?.name ?? (yield* createMonitorName(id));
      const observed = yield* getMonitor(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Elastic");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.monitorName ?? (yield* createMonitorName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getMonitor(subscriptionId, resourceGroup, name);

      // Ensure: the PUT subscribes to the Marketplace plan and provisions
      // the Elastic Cloud deployment in the background.
      if (observed === undefined) {
        yield* elastic.CreateMonitor({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: name,
          location,
          tags,
          kind: news.kind,
          sku: { name: news.sku ?? DEFAULT_ELASTIC_SKU },
          identity:
            (news.systemAssignedIdentity ?? false)
              ? { type: "SystemAssigned" }
              : undefined,
          properties: {
            monitoringStatus: news.monitoringStatus ?? "Enabled",
            userInfo: news.userInfo,
            planDetails: news.planDetails,
            version: news.version,
            hostingType: news.hostingType,
            projectDetails: news.projectDetails,
            generateApiKey: news.generateApiKey,
          },
        });
      }
      observed = yield* waitForMonitor(subscriptionId, resourceGroup, name);

      // Sync: tags are the only aspect PATCH can change.
      if (tagsDiffer(observed.tags, tags)) {
        yield* elastic.UpdateMonitor({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: name,
          tags,
        });
        observed = yield* waitForMonitor(subscriptionId, resourceGroup, name);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elastic.DeleteMonitor({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitorName,
        }),
      );
      yield* waitUntilGone(
        `Elastic monitor ${output.monitorName}`,
        getMonitor(subscriptionId, output.resourceGroup, output.monitorName),
        { interval: "15 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
