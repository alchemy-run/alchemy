import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createStorageChildName } from "./StorageOwnership.ts";

export interface ConnectorProps {
  /** Resource group of the storage account. Changing it replaces the connector. */
  resourceGroup: string;
  /** Storage account that exposes the connector. Changing it replaces the connector. */
  storageAccount: string;
  /**
   * Connector name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connector.
   */
  name?: string;
  /**
   * Azure region; must match the storage account's region. Changing it
   * replaces the connector.
   * @default the provider's default location
   */
  location?: string;
  /**
   * URI of the backing data share,
   * `azds://<region>:<DataShareName>:<DataShareIdentifier>`. Changing it
   * replaces the connector.
   */
  dataShareUri: string;
  /**
   * ARM resource ID of the managed identity used to authenticate to the
   * data share.
   */
  identityResourceId: string;
  /**
   * `Active` or `Inactive`. While inactive, every data-plane request
   * through the connector fails and the connector is not billed.
   * @default "Active"
   */
  state?: "Active" | "Inactive";
  /** Description of the connector (max 250 characters). */
  description?: string;
  /**
   * Test the connection to the data share before creating the connector.
   * @default false
   */
  testConnection?: boolean;
  /** Resource tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface Connector extends Resource<
  "Azure.Storage.Connector",
  ConnectorProps,
  {
    /** Name of the connector. */
    connectorName: string;
    /** Storage account that exposes the connector. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the connector. */
    connectorId: string;
    /** Azure region of the connector. */
    location: string;
    /** System-generated GUID of the connector. */
    uniqueId: string | undefined;
    /** `Active` or `Inactive`. */
    state: string | undefined;
    /** Description of the connector. */
    description: string | undefined;
    /** URI of the backing data share. */
    dataShareUri: string | undefined;
    /** ARM resource ID of the authenticating managed identity. */
    identityResourceId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Storage connector: exposes a Storage Data Share (shared from another
 * tenant or account) as read-only data reachable through this Storage
 * account, authenticated with a managed identity.
 *
 * Storage connectors are a preview feature that needs subscription
 * enrollment and a data share created by the sharing party.
 *
 * ### Connecting a Data Share
 * **Example:** Connector for a shared data set
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("reader", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.Connector("shared-data", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   dataShareUri: "azds://eastus:partnershare:00000000-0000-0000-0000-000000000000",
 *   identityResourceId: identity.identityId,
 *   description: "Partner data set",
 * });
 * ```
 *
 * @resource
 */
export const Connector = Resource<Connector>("Azure.Storage.Connector");

const getConnector = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  connectorName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetConnector({
      subscriptionId,
      resourceGroupName,
      accountName,
      connectorName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  observed: storage.GetConnectorResponse,
): Connector["Attributes"] => ({
  connectorName: name,
  storageAccount,
  resourceGroup,
  connectorId: observed.id ?? "",
  location: observed.location,
  uniqueId: observed.properties.uniqueId,
  state: observed.properties.state,
  description: observed.properties.description,
  dataShareUri: observed.properties.source.connection?.dataShareUri,
  identityResourceId:
    observed.properties.source.authProperties?.identityResourceId,
  tags: userTags(observed.tags),
});

export const ConnectorProvider = () =>
  Provider.succeed(Connector, {
    stables: [
      "connectorName",
      "storageAccount",
      "resourceGroup",
      "connectorId",
    ],

    // Connectors disappear with their storage account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.connectorName) ||
        (news.location !== undefined &&
          news.location.toLowerCase().replace(/\s/g, "") !==
            output.location.toLowerCase().replace(/\s/g, "")) ||
        news.dataShareUri !== output.dataShareUri
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name =
        output?.connectorName ??
        olds?.name ??
        (yield* createStorageChildName(id));
      const observed = yield* getConnector(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return isOwned(id, observed.tags) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name =
        news.name ??
        output?.connectorName ??
        (yield* createStorageChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const state = news.state ?? "Active";
      const authProperties = {
        type: "ManagedIdentity",
        identityResourceId: news.identityResourceId,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        connectorName: name,
      };
      const get = getConnector(
        subscriptionId,
        resourceGroup,
        storageAccount,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* storage.CreateConnector({
          ...where,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {
            state,
            description: news.description,
            testConnection: news.testConnection,
            dataSourceType: "Azure_DataShare",
            source: {
              type: "DataShare",
              connection: {
                type: "DataShare",
                dataShareUri: news.dataShareUri,
              },
              authProperties,
            },
          },
        });
      } else {
        // Sync mutable aspects against the observed connector.
        const p = observed.properties;
        const identityChanged =
          (p.source.authProperties?.identityResourceId ?? "").toLowerCase() !==
          news.identityResourceId.toLowerCase();
        if (
          p.state !== state ||
          (news.description !== undefined &&
            p.description !== news.description) ||
          identityChanged ||
          tagsDiffer(observed.tags, tags)
        ) {
          yield* storage.UpdateConnector({
            ...where,
            tags,
            properties: {
              state,
              description: news.description,
              source: identityChanged
                ? { type: "DataShare", authProperties }
                : undefined,
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `storage connector ${name}`,
        get,
        (value) => value.properties.provisioningState,
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          connectorName: output.connectorName,
        }),
      );
      yield* waitUntilGone(
        `storage connector ${output.connectorName}`,
        getConnector(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.connectorName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
