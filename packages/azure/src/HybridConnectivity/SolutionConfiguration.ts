import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface SolutionConfigurationProps {
  /**
   * ARM resource ID of the parent `Azure.HybridConnectivity.PublicCloudConnector`
   * (its `publicCloudConnectorId`).
   *
   * :::caution
   * Changing it replaces the solution configuration.
   * :::
   */
  resourceUri: string;
  /**
   * Name of the solution configuration: 3-63 letters, digits, and hyphens.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID.
   *
   * :::caution
   * Changing it replaces the solution configuration.
   * :::
   */
  name?: string;
  /**
   * Solution to enable on the connector, e.g. `Microsoft.AssetManagement`
   * (multicloud inventory), `Microsoft.HybridCompute.Onboard` (Arc
   * onboarding of EC2/GCE machines), or `Microsoft.Kubernetes.Onboard`.
   * List the available types with `ListSolutionTypeBySubscription`.
   *
   * :::caution
   * Changing it replaces the solution configuration.
   * :::
   */
  solutionType: string;
  /**
   * Settings of the solution type, as strings (lists are comma-separated),
   * e.g. `{ periodicSync: "true", periodicSyncTime: "1" }`. Azure fills in
   * defaults for settings you leave out; only the settings you set are
   * kept in sync.
   * @default {}
   */
  solutionSettings?: Record<string, string>;
}

export interface SolutionConfiguration extends Resource<
  "Azure.HybridConnectivity.SolutionConfiguration",
  SolutionConfigurationProps,
  {
    /** Name of the solution configuration. */
    solutionConfigurationName: string;
    /** ARM resource ID of the parent connector. */
    resourceUri: string;
    /** ARM resource ID of the solution configuration. */
    solutionConfigurationId: string;
    /** Solution type, e.g. `Microsoft.AssetManagement`. */
    solutionType: string;
    /** Effective settings, including the defaults Azure filled in. */
    solutionSettings: Record<string, string>;
    /**
     * Sync status reported by Azure (e.g. `AuthorizationPending`,
     * `AuthorizationFailed`, `Completed`).
     */
    status: string | undefined;
    /** Detail message for `status`. */
    statusDetails: string | undefined;
    /** ARM provisioning state of the solution configuration. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables a solution (`Microsoft.HybridConnectivity/solutionConfigurations`)
 * on an Azure Arc multicloud connector, such as multicloud inventory or
 * Arc onboarding of AWS and Google Cloud machines.
 *
 * Solution configurations carry no tags or free-form fields, so Alchemy
 * cannot mark them; one found at the expected scope is treated as this
 * resource. The solution reports `AuthorizationFailed` until the
 * connector's onboarding template is deployed in the other cloud.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/multicloud-connector/view-multicloud-inventory
 *
 * ### Enabling multicloud inventory
 * **Example:** Inventory EC2 and S3 hourly
 * ```typescript
 * const connector = yield* Azure.HybridConnectivity.PublicCloudConnector("Aws", {
 *   hostType: "AWS",
 *   awsCloudProfile: { accountId: "123456789012" },
 * });
 * const inventory = yield* Azure.HybridConnectivity.SolutionConfiguration("Inventory", {
 *   resourceUri: connector.publicCloudConnectorId,
 *   solutionType: "Microsoft.AssetManagement",
 *   solutionSettings: {
 *     cloudProviderServiceTypes: "ec2,s3",
 *     periodicSync: "true",
 *     periodicSyncTime: "1",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SolutionConfiguration = Resource<SolutionConfiguration>(
  "Azure.HybridConnectivity.SolutionConfiguration",
);

/** 3-63 letters, digits, and hyphens. */
const createConfigurationName = (id: string) => createPhysicalName({ id, maxLength: 63 });

/** Lowercased ARM id comparison (ARM echoes ids with mixed casing). */
const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const getConfiguration = (resourceUri: string, solutionConfiguration: string) =>
  orUndefinedIfNotFound(
    hybridconnectivity.GetSolutionConfiguration({ resourceUri, solutionConfiguration }),
  );

const settingsOf = (observed: hybridconnectivity.GetSolutionConfigurationResponse) =>
  Object.fromEntries(
    Object.entries(observed.properties?.solutionSettings ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  );

const toAttrs = (
  resourceUri: string,
  name: string,
  observed: hybridconnectivity.GetSolutionConfigurationResponse,
): SolutionConfiguration["Attributes"] => ({
  solutionConfigurationName: name,
  resourceUri,
  solutionConfigurationId: observed.id ?? "",
  solutionType: observed.properties?.solutionType ?? "",
  solutionSettings: settingsOf(observed),
  status: observed.properties?.status,
  statusDetails: observed.properties?.statusDetails,
  provisioningState: observed.properties?.provisioningState,
});

export const SolutionConfigurationProvider = () =>
  Provider.succeed(SolutionConfiguration, {
    stables: ["solutionConfigurationName", "resourceUri", "solutionConfigurationId"],

    // Extension resources vanish with the connector they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceUri, output.resourceUri) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.solutionConfigurationName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      // A user-chosen name keeps the same ARM id, so the old configuration
      // must go first; a generated name moves to a fresh one.
      if (news.solutionType.toLowerCase() !== output.solutionType.toLowerCase()) {
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const resourceUri = output?.resourceUri ?? olds?.resourceUri;
      if (resourceUri === undefined) return undefined;
      const generated = yield* createConfigurationName(id);
      const name = output?.solutionConfigurationName ?? olds?.name ?? generated;
      const observed = yield* getConfiguration(resourceUri, name);
      return observed === undefined ? undefined : toAttrs(resourceUri, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridConnectivity");
      const { resourceUri } = news;
      const generated = yield* createConfigurationName(id);
      const name = news.name ?? output?.solutionConfigurationName ?? generated;
      const settings = news.solutionSettings ?? {};
      const get = getConfiguration(resourceUri, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. PATCH is rejected ("The resource validation failed"),
      // so the upserting PUT converges both a missing configuration and
      // drift in the settings the user set.
      const observedSettings = observed === undefined ? {} : settingsOf(observed);
      const drift =
        observed === undefined ||
        Object.entries(settings).some(([key, value]) => observedSettings[key] !== value);
      if (drift) {
        yield* hybridconnectivity.SolutionConfigurationsCreateOrUpdate({
          resourceUri,
          solutionConfiguration: name,
          properties: {
            solutionType: news.solutionType,
            solutionSettings: { ...observedSettings, ...settings },
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `solution configuration ${resourceUri}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
      );
      return toAttrs(resourceUri, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        hybridconnectivity.DeleteSolutionConfiguration({
          resourceUri: output.resourceUri,
          solutionConfiguration: output.solutionConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `solution configuration ${output.resourceUri}/${output.solutionConfigurationName}`,
        getConfiguration(output.resourceUri, output.solutionConfigurationName),
      );
    }),
  });
