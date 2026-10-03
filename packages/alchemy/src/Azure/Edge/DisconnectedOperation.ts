import * as edge from "@distilled.cloud/azure/edge";
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
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";

/** One billing period of a disconnected operation. */
export interface DisconnectedOperationBillingPeriod {
  /** Number of physical cores licensed for the period. */
  cores: number;
  /** Pricing model of the period: `Trial` or `Annual`. */
  pricingModel: "Trial" | "Annual" | (string & {});
}

/** Billing configuration of a disconnected operation. */
export interface DisconnectedOperationBillingConfiguration {
  /** Whether the billing period renews automatically: `Enabled` or `Disabled`. */
  autoRenew: "Enabled" | "Disabled" | (string & {});
  /** The current billing period. */
  current: DisconnectedOperationBillingPeriod;
  /** The billing period that takes over when the current one ends. */
  upcoming?: DisconnectedOperationBillingPeriod;
}

/** Benefit plans of a disconnected operation. */
export interface DisconnectedOperationBenefitPlans {
  /** Azure Hybrid Benefit for Windows Server: `Enabled` or `Disabled`. */
  azureHybridWindowsServerBenefit?: "Enabled" | "Disabled" | (string & {});
  /** Number of Windows Server VMs licensed under the Azure Hybrid Benefit. */
  windowsServerVmCount?: number;
}

export interface DisconnectedOperationProps {
  /** Resource group the disconnected operation is created in. Changing it replaces the resource. */
  resourceGroup: string;
  /**
   * Name of the disconnected operation. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * resource.
   */
  name?: string;
  /**
   * Azure location of the disconnected operation. Changing it replaces the
   * resource.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Whether the Azure Local appliance is meant to run connected to Azure or
   * fully disconnected.
   */
  connectionIntent: "Connected" | "Disconnected" | (string & {});
  /** Registration intent of the appliance: `Registered` or `Unregistered`. */
  registrationStatus?: "Registered" | "Unregistered" | (string & {});
  /** Version of the disconnected operations appliance software. */
  deviceVersion?: string;
  /** Capacity billing configuration (cores and pricing model). */
  billingConfiguration?: DisconnectedOperationBillingConfiguration;
  /** Azure Hybrid Benefit plans applied to the appliance. */
  benefitPlans?: DisconnectedOperationBenefitPlans;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DisconnectedOperation extends Resource<
  "Azure.Edge.DisconnectedOperation",
  DisconnectedOperationProps,
  {
    /** Name of the disconnected operation. */
    disconnectedOperationName: string;
    /** Resource group that holds the disconnected operation. */
    resourceGroup: string;
    /** ARM resource ID of the disconnected operation. */
    disconnectedOperationId: string;
    /** Location of the disconnected operation. */
    location: string;
    /** Unique GUID of the appliance stamp. */
    stampId: string;
    /** Billing model (`Capacity`). */
    billingModel: string;
    /** Connection intent of the appliance. */
    connectionIntent: string;
    /** Observed connection status of the appliance. */
    connectionStatus: string | undefined;
    /** Registration intent of the appliance. */
    registrationStatus: string | undefined;
    /** Billing status (`Enabled`, `Disabled`, or `Stopped`). */
    billingStatus: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Local disconnected operations registration. It registers an
 * Azure Local appliance that runs Azure services without a connection to
 * Azure, and carries its capacity billing configuration and benefit plans.
 *
 * Creating one requires an approved disconnected operations enrollment for
 * the subscription and starts capacity billing.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/disconnected-operations-overview
 *
 * ### Registering a disconnected appliance
 * **Example:** Disconnected operation with trial billing
 * ```typescript
 * const appliance = yield* Azure.Edge.DisconnectedOperation("appliance", {
 *   resourceGroup: group.resourceGroupName,
 *   connectionIntent: "Disconnected",
 *   billingConfiguration: {
 *     autoRenew: "Disabled",
 *     current: { cores: 16, pricingModel: "Trial" },
 *   },
 * });
 * ```
 *
 * ### Benefit plans
 * **Example:** Enable Azure Hybrid Benefit for Windows Server
 * ```typescript
 * const appliance = yield* Azure.Edge.DisconnectedOperation("appliance", {
 *   resourceGroup: group.resourceGroupName,
 *   connectionIntent: "Connected",
 *   benefitPlans: {
 *     azureHybridWindowsServerBenefit: "Enabled",
 *     windowsServerVmCount: 4,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DisconnectedOperation = Resource<DisconnectedOperation>(
  "Azure.Edge.DisconnectedOperation",
);

/**
 * Subscriptions without a disconnected operations enrollment do not see the
 * resource type at all: ARM answers `InvalidResourceType`, so no resource can
 * exist there.
 */
const getDisconnectedOperation = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    edge.GetDisconnectedOperation({ subscriptionId, resourceGroupName, name }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: edge.GetDisconnectedOperationResponse,
): DisconnectedOperation["Attributes"] => ({
  disconnectedOperationName: name,
  resourceGroup,
  disconnectedOperationId: observed.id ?? "",
  location: observed.location,
  stampId: observed.properties?.stampId ?? "",
  billingModel: observed.properties?.billingModel ?? "",
  connectionIntent: observed.properties?.connectionIntent ?? "",
  connectionStatus: observed.properties?.connectionStatus,
  registrationStatus: observed.properties?.registrationStatus,
  billingStatus: observed.properties?.billingConfiguration?.billingStatus,
  tags: userTags(observed.tags),
});

const physicalName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const observedPeriod = (period: edge.BillingPeriod | undefined) =>
  period === undefined
    ? undefined
    : { cores: period.cores, pricingModel: period.pricingModel };

/**
 * The PATCH properties needed to move the observed resource to the desired
 * props. Only aspects the user declared are compared and sent.
 */
const propertyDelta = (
  news: DisconnectedOperationProps,
  observed: edge.DisconnectedOperationProperties | undefined,
): edge.DisconnectedOperationUpdateProperties | undefined => {
  const delta: edge.DisconnectedOperationUpdateProperties = {};
  if (news.connectionIntent !== observed?.connectionIntent) {
    delta.connectionIntent = news.connectionIntent;
  }
  if (
    news.registrationStatus !== undefined &&
    news.registrationStatus !== observed?.registrationStatus
  ) {
    delta.registrationStatus = news.registrationStatus;
  }
  if (
    news.deviceVersion !== undefined &&
    news.deviceVersion !== observed?.deviceVersion
  ) {
    delta.deviceVersion = news.deviceVersion;
  }
  if (news.billingConfiguration !== undefined) {
    const current = observed?.billingConfiguration;
    if (
      !sameJson(news.billingConfiguration, {
        autoRenew: current?.autoRenew,
        current: observedPeriod(current?.current),
        upcoming: observedPeriod(current?.upcoming),
      })
    ) {
      delta.billingConfiguration = news.billingConfiguration;
    }
  }
  if (
    news.benefitPlans !== undefined &&
    !sameJson(news.benefitPlans, observed?.benefitPlans ?? {})
  ) {
    delta.benefitPlans = news.benefitPlans;
  }
  return Object.keys(delta).length === 0 ? undefined : delta;
};

export const DisconnectedOperationProvider = () =>
  Provider.succeed(DisconnectedOperation, {
    stables: [
      "disconnectedOperationName",
      "resourceGroup",
      "disconnectedOperationId",
      "location",
      "stampId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListDisconnectedOperationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDisconnectedOperationBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed({ value: [] as edge.DisconnectedOperation[] }),
          ),
        );
      return page.value.flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.disconnectedOperationName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
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
        output?.disconnectedOperationName ??
        olds?.name ??
        (yield* physicalName(id));
      const observed = yield* getDisconnectedOperation(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.disconnectedOperationName ??
        (yield* physicalName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getDisconnectedOperation(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* edge.DisconnectedOperationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {
            connectionIntent: news.connectionIntent,
            registrationStatus: news.registrationStatus,
            deviceVersion: news.deviceVersion,
            billingConfiguration: news.billingConfiguration,
            benefitPlans: news.benefitPlans,
          },
        });
      } else {
        // Sync properties and tags against the observed resource.
        const properties = propertyDelta(news, observed.properties);
        const syncTags = tagsDiffer(observed.tags, tags);
        if (properties !== undefined || syncTags) {
          yield* edge.UpdateDisconnectedOperation({
            subscriptionId,
            resourceGroupName: resourceGroup,
            name,
            tags: syncTags ? tags : undefined,
            properties,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `edge disconnected operation ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteDisconnectedOperation({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.disconnectedOperationName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `edge disconnected operation ${output.disconnectedOperationName}`,
        getDisconnectedOperation(
          subscriptionId,
          output.resourceGroup,
          output.disconnectedOperationName,
        ),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
