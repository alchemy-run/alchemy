import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./Account.ts";
import {
  ACCOUNT_BUDGET,
  createChildName,
  sameArm,
  sameValue,
  whileAccountBusy,
} from "./Common.ts";

export interface CapabilityHostProps {
  /** Resource group of the account. Changing it replaces the host. */
  resourceGroup: string;
  /** Account (with `allowProjectManagement`) that holds the host. Changing it replaces the host. */
  account: string;
  /**
   * Capability host name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the host.
   */
  name?: string;
  /**
   * Kind of capability the host provides.
   * @default "Agents"
   */
  capabilityHostKind?: "Agents";
  /**
   * Description of the host (Azure does not return it). Changing it
   * replaces the host.
   */
  description?: string;
  /** Names of connections to Azure AI services / Azure OpenAI used by agents. */
  aiServicesConnections?: string[];
  /** Names of Azure Storage connections for agent files (standard setup). */
  storageConnections?: string[];
  /** Names of Cosmos DB connections for agent threads (standard setup). */
  threadStorageConnections?: string[];
  /** Names of Azure AI Search connections for vector stores (standard setup). */
  vectorStoreConnections?: string[];
  /** ARM ID of a delegated subnet for agent network injection. */
  customerSubnet?: string;
  /** Allow the public hosting environment. */
  enablePublicHostingEnvironment?: boolean;
}

export interface CapabilityHost extends Resource<
  "Azure.CognitiveServices.CapabilityHost",
  CapabilityHostProps,
  {
    /** Name of the capability host. */
    capabilityHostName: string;
    /** ARM resource ID of the capability host. */
    capabilityHostId: string;
    /** Account that holds the host. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Kind of capability. */
    capabilityHostKind: string;
  },
  never,
  Providers
> {}

/**
 * An account-level capability host
 * (`Microsoft.CognitiveServices/accounts/capabilityHosts`) that enables the
 * Azure AI Foundry Agent Service for every project of an account. With no
 * connections it uses Microsoft-managed storage ("basic setup"); listing
 * Storage, Cosmos DB, and AI Search connections switches to customer-owned
 * resources ("standard setup").
 *
 * Capability hosts cannot be updated: every property change replaces the
 * host. Azure does not persist tags on capability hosts, so ownership
 * follows the parent account's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/agents/concepts/capability-hosts
 *
 * ### Enabling Agents
 * **Example:** Basic setup for a Foundry account
 * ```typescript
 * const host = yield* Azure.CognitiveServices.CapabilityHost("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * ```
 *
 * **Example:** Standard setup with customer-owned resources
 * ```typescript
 * const host = yield* Azure.CognitiveServices.CapabilityHost("agents", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   storageConnections: [storageConnection.connectionName],
 *   threadStorageConnections: [cosmosConnection.connectionName],
 *   vectorStoreConnections: [searchConnection.connectionName],
 * });
 * ```
 *
 * @resource
 */
export const CapabilityHost = Resource<CapabilityHost>(
  "Azure.CognitiveServices.CapabilityHost",
);

const getHost = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  capabilityHostName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetAccountCapabilityHost({
      subscriptionId,
      resourceGroupName,
      accountName,
      capabilityHostName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  host: cognitiveservices.GetAccountCapabilityHostResponse,
): CapabilityHost["Attributes"] => ({
  capabilityHostName: name,
  capabilityHostId: host.id ?? "",
  account,
  resourceGroup,
  capabilityHostKind: host.properties.capabilityHostKind ?? "Agents",
});

const sortedOrEmpty = (list: ReadonlyArray<string> | null | undefined) =>
  [...(list ?? [])].sort();

export const CapabilityHostProvider = () =>
  Provider.succeed(CapabilityHost, {
    stables: [
      "capabilityHostName",
      "capabilityHostId",
      "account",
      "resourceGroup",
      "capabilityHostKind",
    ],

    // Capability hosts live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    // Capability hosts are not updatable: any change replaces the host.
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.capabilityHostName)) ||
        (news.capabilityHostKind ?? "Agents") !== output.capabilityHostKind
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const settings = (p: CapabilityHostProps) => ({
          description: p.description,
          aiServicesConnections: sortedOrEmpty(p.aiServicesConnections),
          storageConnections: sortedOrEmpty(p.storageConnections),
          threadStorageConnections: sortedOrEmpty(p.threadStorageConnections),
          vectorStoreConnections: sortedOrEmpty(p.vectorStoreConnections),
          customerSubnet: p.customerSubnet?.toLowerCase(),
          enablePublicHostingEnvironment: p.enablePublicHostingEnvironment,
        });
        // An explicit name stays the same across the replacement, and an
        // account holds a single agents capability host: delete first.
        if (!sameValue(settings(olds), settings(news))) {
          return { action: "replace", deleteFirst: true } as const;
        }
      }
      return undefined;
    }),

    // Azure drops tags on capability hosts; ownership follows the account.
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.capabilityHostName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getHost(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.capabilityHostName ?? (yield* createChildName(id));
      const get = getHost(subscriptionId, resourceGroup, account, name);

      // Observe; a host is created once and never updated in place.
      const observed = yield* get;
      if (observed === undefined) {
        yield* cognitiveservices
          .AccountCapabilityHostsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            capabilityHostName: name,
            properties: {
              capabilityHostKind: news.capabilityHostKind ?? "Agents",
              description: news.description,
              aiServicesConnections: news.aiServicesConnections,
              storageConnections: news.storageConnections,
              threadStorageConnections: news.threadStorageConnections,
              vectorStoreConnections: news.vectorStoreConnections,
              customerSubnet: news.customerSubnet,
              enablePublicHostingEnvironment:
                news.enablePublicHostingEnvironment,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `capability host ${name}`,
        get,
        (host) => host.properties.provisioningState,
        ACCOUNT_BUDGET,
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteAccountCapabilityHost({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            capabilityHostName: output.capabilityHostName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `capability host ${output.capabilityHostName}`,
        getHost(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.capabilityHostName,
        ),
        ACCOUNT_BUDGET,
      );
    }),
  });
