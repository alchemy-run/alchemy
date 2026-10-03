import * as security from "@distilled.cloud/azure/security";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface DataScannerProps {
  /**
   * Resource group the scanner is scoped to. If omitted, the scanner is
   * scoped to the whole subscription, which holds at most one
   * subscription-scoped scanner. Changing it replaces the scanner.
   */
  resourceGroup?: string;
  /**
   * Name of the scanner, letters, digits, and `-`. The API documents up
   * to 260 characters, but names longer than 90 fail with an internal
   * server error. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the scanner.
   */
  name?: string;
}

export interface DataScanner extends Resource<
  "Azure.Security.DataScanner",
  DataScannerProps,
  {
    /** Name of the scanner. */
    dataScannerName: string;
    /**
     * ARM ID of the scope that holds the scanner: `/subscriptions/{id}` or
     * `/subscriptions/{id}/resourceGroups/{name}`.
     */
    scope: string;
    /** Resource group of the scanner, or `undefined` at subscription scope. */
    resourceGroup: string | undefined;
    /** ARM resource ID of the scanner. */
    dataScannerId: string;
    /**
     * Object ID of the scanner's system-assigned managed identity. Use it
     * as the `principalId` of a role assignment.
     */
    principalId: string;
    /** Microsoft Entra tenant of the system-assigned identity. */
    tenantId: string;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Defender for Cloud data scanner — an identity-only resource
 * Defender for Storage uses to scan data for malware and sensitive
 * information. The scanner is defined solely by its system-assigned
 * managed identity (the only identity type the API accepts); grant that
 * identity access to the data it should scan. A subscription holds at most
 * one subscription-scoped scanner; resource groups may hold several.
 *
 * @see https://learn.microsoft.com/azure/defender-for-cloud/defender-for-storage-introduction
 *
 * ### Creating a Data Scanner
 * **Example:** Scanner scoped to a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("data");
 * const scanner = yield* Azure.Security.DataScanner("scanner", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Scanner scoped to the subscription
 * ```typescript
 * const scanner = yield* Azure.Security.DataScanner("scanner", {});
 * ```
 *
 * ### Granting Access
 * **Example:** Let the scanner read blobs in a storage account
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("scanner-reads-files", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: scanner.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const DataScanner = Resource<DataScanner>("Azure.Security.DataScanner");

const scopeOf = (subscriptionId: string, resourceGroup: string | undefined) =>
  resourceGroup === undefined
    ? `/subscriptions/${subscriptionId}`
    : `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;

const getScanner = (scopeId: string, scannerName: string) =>
  orUndefinedIfNotFound(security.GetDataScanner({ scopeId, scannerName }));

const generatedName = (id: string) =>
  createPhysicalName({ id, maxLength: 90 });

const hasSystemIdentity = (scanner: security.GetDataScannerResponse) =>
  scanner.identity?.type?.toLowerCase() === "systemassigned" &&
  scanner.identity.principalId !== undefined;

const toAttrs = (
  scope: string,
  resourceGroup: string | undefined,
  name: string,
  scanner: security.GetDataScannerResponse,
): DataScanner["Attributes"] => ({
  dataScannerName: name,
  scope,
  resourceGroup,
  dataScannerId:
    scanner.id ?? `${scope}/providers/Microsoft.Security/dataScanners/${name}`,
  principalId: scanner.identity?.principalId ?? "",
  tenantId: scanner.identity?.tenantId ?? "",
});

export const DataScannerProvider = () =>
  Provider.succeed(DataScanner, {
    stables: [
      "dataScannerName",
      "scope",
      "resourceGroup",
      "dataScannerId",
      "principalId",
      "tenantId",
    ],

    // No tags or other marker exist on a data scanner, so ownership cannot be
    // proven from a list. Resource-group-scoped scanners vanish with their
    // (tagged) resource group.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? olds?.name ?? (yield* generatedName(id));
      if (
        (news.resourceGroup ?? "").toLowerCase() !==
          (output.resourceGroup ?? "").toLowerCase() ||
        name.toLowerCase() !== output.dataScannerName.toLowerCase()
      ) {
        // A subscription holds one subscription-scoped scanner, so a
        // replacement there must delete the old scanner first.
        return news.resourceGroup === undefined ||
          output.resourceGroup === undefined
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const scope = output?.scope ?? scopeOf(subscriptionId, resourceGroup);
      const generated = yield* generatedName(id);
      const name = output?.dataScannerName ?? olds?.name ?? generated;
      const observed = yield* getScanner(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, resourceGroup, name, observed);
      // No tags: the instance-unique generated name (or persisted output) is
      // the ownership marker; an explicitly named foreign scanner is unowned.
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Security");
      const resourceGroup = news.resourceGroup;
      const scope = scopeOf(subscriptionId, resourceGroup);
      const name =
        news.name ?? output?.dataScannerName ?? (yield* generatedName(id));

      // Observe.
      let observed = yield* getScanner(scope, name);

      // Ensure: the PUT is a synchronous upsert. The scanner has no mutable
      // properties; its system-assigned identity is re-asserted if missing
      // (`None` is rejected with an internal server error).
      if (observed === undefined || !hasSystemIdentity(observed)) {
        observed = yield* security.DataScannersCreateOrUpdate({
          scopeId: scope,
          scannerName: name,
          properties: {},
          identity: { type: "SystemAssigned" },
        });
      }

      return toAttrs(scope, resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        security.DeleteDataScanner({
          scopeId: output.scope,
          scannerName: output.dataScannerName,
        }),
      );
      yield* waitUntilGone(
        `data scanner ${output.dataScannerName}`,
        getScanner(output.scope, output.dataScannerName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
