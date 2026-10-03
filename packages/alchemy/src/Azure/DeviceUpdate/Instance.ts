import * as deviceupdate from "@distilled.cloud/azure/deviceupdate";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Redacted from "effect/Redacted";
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
import { getDeviceUpdateAccount } from "./Account.ts";

export interface DeviceUpdateDiagnosticStorage {
  /** ARM resource ID of the storage account that receives diagnostic logs. */
  resourceId: string;
  /**
   * Connection string of the storage account (key-based authentication).
   * Azure never returns it, so it is sent whenever the storage account or
   * the diagnostics setting changes.
   */
  connectionString?: string | Redacted.Redacted<string>;
}

export interface InstanceProps {
  /** Resource group of the Device Update account. Changing it replaces the instance. */
  resourceGroup: string;
  /** Name of the parent Device Update account. Changing it replaces the instance. */
  account: string;
  /**
   * Instance name: 3-36 letters, digits, and single hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the instance.
   */
  name?: string;
  /**
   * Azure location of the instance; must match the account's location.
   * Changing it replaces the instance.
   * @default the parent account's location
   */
  location?: string;
  /**
   * ARM resource IDs of the IoT Hubs the instance manages. Device Update
   * adds its own consumer group and route to each hub. The "Azure Device
   * Update" service principal (app ID
   * `6ee392c4-d339-4083-b04d-6b7947c6cf78`) must hold
   * `IoT Hub Data Contributor` on each hub, or creation fails with
   * `ResourceCreationValidateFailed`.
   */
  iotHubs: string[];
  /**
   * Collect device diagnostic logs into `diagnosticStorage`.
   * @default Azure's default (`false`)
   */
  enableDiagnostics?: boolean;
  /** Storage account that receives customer-initiated diagnostic logs. */
  diagnosticStorage?: DeviceUpdateDiagnosticStorage;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Instance extends Resource<
  "Azure.DeviceUpdate.Instance",
  InstanceProps,
  {
    /** Name of the instance. */
    instanceName: string;
    /** ARM resource ID of the instance. */
    instanceId: string;
    /** Name of the parent Device Update account. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the instance. */
    location: string;
    /** ARM resource IDs of the connected IoT Hubs. */
    iotHubs: string[];
    /** Whether diagnostic log collection is enabled. */
    enableDiagnostics: boolean;
    /** ARM resource ID of the diagnostic storage account, if any. */
    diagnosticStorageResourceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Device Update for IoT Hub instance — connects a Device Update account to
 * one or more IoT Hubs so their devices can receive over-the-air updates.
 *
 * @see https://learn.microsoft.com/azure/iot-hub-device-update/create-device-update-account
 *
 * ### Creating an Instance
 * **Example:** Instance connected to an IoT Hub
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const hub = yield* Azure.IoTHub.IotHub("devices", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // Let the "Azure Device Update" service principal manage the hub.
 * const grant = yield* Azure.Authorization.RoleAssignment("adu-hub", {
 *   scope: hub.iotHubId,
 *   roleDefinitionId: "4fc6c259-987e-4a07-842e-c321cc9d413f", // IoT Hub Data Contributor
 *   principalId: deviceUpdatePrincipalObjectId,
 *   principalType: "ServicePrincipal",
 * });
 * const account = yield* Azure.DeviceUpdate.Account("updates", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   iotHubs: [grant.scope],
 * });
 * ```
 *
 * ### Diagnostics
 * **Example:** Collect device diagnostic logs into a storage account
 * ```typescript
 * const logs = yield* Azure.Storage.StorageAccount("logs", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const instance = yield* Azure.DeviceUpdate.Instance("fleet", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   iotHubs: [hub.iotHubId],
 *   enableDiagnostics: true,
 *   diagnosticStorage: {
 *     resourceId: logs.storageAccountId,
 *     connectionString: logsConnectionString,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Instance = Resource<Instance>("Azure.DeviceUpdate.Instance");

type ObservedInstance = deviceupdate.GetInstanceResponse;

const createInstanceName = (id: string) =>
  createPhysicalName({ id, maxLength: 36, lowercase: true, delimiter: "-" });

const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  instanceName: string,
) =>
  orUndefinedIfNotFound(
    deviceupdate.GetInstance({
      subscriptionId,
      resourceGroupName,
      accountName,
      instanceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  name: string,
  instance: ObservedInstance,
): Instance["Attributes"] => ({
  instanceName: name,
  instanceId: instance.id ?? "",
  accountName,
  resourceGroup,
  location: instance.location,
  iotHubs: (instance.properties?.iotHubs ?? []).map((h) => h.resourceId),
  enableDiagnostics: instance.properties?.enableDiagnostics ?? false,
  diagnosticStorageResourceId:
    instance.properties?.diagnosticStorageProperties?.resourceId,
  tags: userTags(instance.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * Device Update keeps the create PUT open after the resource already reports
 * `Succeeded`; a second write meanwhile fails with ARM's
 * `InvalidResourceOperation` "... is active/in-progress" (typed as
 * `HybridNetworkOperationInProgress`) or the RP's own `OperationInProgress`
 * (`DeviceUpdateOperationInProgress`). Wait it out.
 */
const whileOperationInProgress = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "HybridNetworkOperationInProgress" ||
    e._tag === "DeviceUpdateOperationInProgress",
  schedule: Schedule.spaced("10 seconds"),
  times: 36,
} as const;

const sameIds = (a: string[], b: string[]) =>
  a
    .map((x) => x.toLowerCase())
    .sort()
    .join("|") ===
  b
    .map((x) => x.toLowerCase())
    .sort()
    .join("|");

/**
 * Device Update validates on create that its first-party service principal
 * can manage every listed hub (`IoT Hub Data Contributor`). A role
 * assignment made in the same deploy takes a while to propagate, during
 * which the PUT fails with `ResourceCreationValidateFailed` (typed as
 * `DatadogMonitorCreationValidateFailed`, which shares the ARM code).
 */
const whileHubAccessPropagating = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "DatadogMonitorCreationValidateFailed",
  schedule: Schedule.spaced("15 seconds"),
  times: 12,
} as const;

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: [
      "instanceName",
      "instanceId",
      "accountName",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* deviceupdate
        .ListAccountBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAccountBySubscription", page),
          ),
        );
      const results: Instance["Attributes"][] = [];
      for (const account of accounts.value ?? []) {
        const group = resourceGroupOf(account.id);
        if (group === undefined || account.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          deviceupdate
            .ListInstanceByAccount({
              subscriptionId,
              resourceGroupName: group,
              accountName: account.name,
            })
            .pipe(
              Effect.flatMap((page) =>
                requireSinglePage("ListInstanceByAccount", page),
              ),
            ),
        );
        for (const instance of page?.value ?? []) {
          if (hasAnyAlchemyTag(instance.tags) && instance.name !== undefined) {
            results.push(toAttrs(group, account.name, instance.name, instance));
          }
        }
      }
      return results;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.account) !== lower(output.accountName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.instanceName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, ""))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const accountName = output?.accountName ?? olds?.account;
      if (resourceGroup === undefined || accountName === undefined) {
        return undefined;
      }
      const name =
        output?.instanceName ?? olds?.name ?? (yield* createInstanceName(id));
      const observed = yield* getInstance(
        subscriptionId,
        resourceGroup,
        accountName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, accountName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DeviceUpdate");
      const resourceGroup = news.resourceGroup;
      const accountName = news.account;
      const name =
        news.name ?? output?.instanceName ?? (yield* createInstanceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName,
        instanceName: name,
      };
      const label = `device update instance ${accountName}/${name}`;
      const get = getInstance(subscriptionId, resourceGroup, accountName, name);
      const wait = waitForProvisioned(
        label,
        get,
        (instance) => instance.properties?.provisioningState,
        // Instances report `Creating` for well over 10 minutes.
        { interval: "10 seconds", times: 180 },
      );
      // Sent only when set: Azure rejects an explicit `false` without
      // diagnostic storage (`ResourceCreationValidateFailed`).
      const enableDiagnostics = news.enableDiagnostics;

      // Observe.
      let observed = yield* get;

      // Ensure + sync settings: PUT is the only way to change hubs and
      // diagnostics, so send it when missing or any setting drifted.
      const settingsDiffer =
        observed === undefined ||
        !sameIds(
          (observed.properties?.iotHubs ?? []).map((h) => h.resourceId),
          news.iotHubs,
        ) ||
        (enableDiagnostics !== undefined &&
          (observed.properties?.enableDiagnostics ?? false) !==
            enableDiagnostics) ||
        lower(observed.properties?.diagnosticStorageProperties?.resourceId) !==
          lower(news.diagnosticStorage?.resourceId);
      if (settingsDiffer) {
        const location =
          observed?.location ??
          news.location ??
          output?.location ??
          (yield* getDeviceUpdateAccount(
            subscriptionId,
            resourceGroup,
            accountName,
          ))?.location ??
          env.location;
        yield* deviceupdate
          .CreateInstance({
            ...where,
            location,
            tags,
            properties: {
              iotHubs: news.iotHubs.map((resourceId) => ({ resourceId })),
              enableDiagnostics,
              diagnosticStorageProperties: news.diagnosticStorage
                ? {
                    authenticationType: "KeyBased",
                    resourceId: news.diagnosticStorage.resourceId,
                    connectionString: news.diagnosticStorage.connectionString,
                  }
                : undefined,
            },
          })
          .pipe(
            Effect.retry(whileOperationInProgress),
            Effect.retry(whileHubAccessPropagating),
          );
      }
      observed = yield* wait;

      // Tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* deviceupdate
          .UpdateInstance({ ...where, tags })
          .pipe(Effect.retry(whileOperationInProgress));
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, accountName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        deviceupdate
          .DeleteInstance({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.accountName,
            instanceName: output.instanceName,
          })
          .pipe(Effect.retry(whileOperationInProgress)),
      );
      yield* waitUntilGone(
        `device update instance ${output.accountName}/${output.instanceName}`,
        getInstance(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.instanceName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DeviceUpdate.Account",
      ],
    },
  });
