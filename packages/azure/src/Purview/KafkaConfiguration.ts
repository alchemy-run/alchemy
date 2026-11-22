import * as purview from "@distilled.cloud/azure/purview";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  resourceGroupOf,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { accountOwnedByStage, createKafkaConfigurationName, sameName } from "./internal.ts";

export interface KafkaConfigurationCredentials {
  /**
   * Identity Purview uses to reach the event hub: the account's
   * system-assigned identity, or one of its user-assigned identities.
   */
  type: "SystemAssigned" | "UserAssigned";
  /**
   * ARM ID of the user-assigned identity (with `type: "UserAssigned"`).
   * @default none
   */
  identityId?: string;
}

export interface KafkaConfigurationProps {
  /**
   * Resource group of the account.
   *
   * :::caution
   * Changing it replaces the configuration.
   * :::
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Purview account.
   *
   * :::caution
   * Changing it replaces the configuration.
   * :::
   */
  account: string;
  /**
   * Configuration name: letters, digits, hyphens, and underscores.
   *
   * :::caution
   * Changing it replaces the configuration.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * ARM ID of the event hub (`Microsoft.EventHub/namespaces/eventhubs`),
   * e.g. `hub.eventHubId`.
   */
  eventHubId: string;
  /**
   * `Notification`: Purview publishes Data Map change events (Atlas
   * entity notifications) to the event hub. `Hook`: Purview reads Atlas
   * hook messages from the event hub to create or update assets.
   */
  eventHubType: "Notification" | "Hook";
  /**
   * Consumer group Purview reads with. Required for a `Hook` event hub.
   * @default none
   */
  consumerGroup?: string;
  /**
   * Partition Purview publishes notifications to.
   * @default every partition
   */
  eventHubPartitionId?: string;
  /**
   * Identity Purview authenticates to Event Hubs with. Grant it
   * `Azure Event Hubs Data Sender` (notifications) or
   * `Azure Event Hubs Data Receiver` (hooks) on the event hub.
   * @default { type: "SystemAssigned" }
   */
  credentials?: KafkaConfigurationCredentials;
  /**
   * Whether event streaming is on.
   * @default "Enabled"
   */
  eventStreamingState?: "Enabled" | "Disabled";
}

export interface KafkaConfiguration extends Resource<
  "Azure.Purview.KafkaConfiguration",
  KafkaConfigurationProps,
  {
    /** Name of the configuration. */
    kafkaConfigurationName: string;
    /** ARM resource ID of the configuration. */
    kafkaConfigurationId: string;
    /** Name of the Purview account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM ID of the event hub. */
    eventHubId: string | undefined;
    /** `Notification` or `Hook`. */
    eventHubType: string | undefined;
    /** Consumer group Purview reads with. */
    consumerGroup: string | undefined;
    /** Partition notifications are published to. */
    eventHubPartitionId: string | undefined;
    /** Identity type Purview authenticates with. */
    credentialsType: string | undefined;
    /** User-assigned identity Purview authenticates with. */
    credentialsIdentityId: string | undefined;
    /** Whether event streaming is on. */
    eventStreamingState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Kafka configuration of a Purview account
 * (`Microsoft.Purview/accounts/kafkaConfigurations`) — connects the
 * account to your own Event Hubs event hub for Atlas Kafka notifications
 * (Purview publishes Data Map changes) or hooks (Purview ingests asset
 * updates you send).
 *
 * Kafka configurations have no tags. They count as owned when their
 * account carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/purview/data-map-kafa-notifications
 *
 * ### Publishing Data Map Notifications
 * **Example:** Send Atlas notifications to an event hub
 * ```typescript
 * const catalog = yield* Azure.Purview.Account("catalog", {
 *   managedEventHubState: "Disabled",
 * });
 * const namespace = yield* Azure.EventHub.Namespace("events");
 * const hub = yield* Azure.EventHub.EventHub("atlas", {
 *   namespace: namespace.namespaceName,
 * });
 * yield* Azure.Authorization.RoleAssignment("catalog-sends", {
 *   scope: hub.eventHubId,
 *   roleDefinitionId: "2b629674-e913-4c01-ae53-ef4638d8f975", // Azure Event Hubs Data Sender
 *   principalId: catalog.principalId.as<string>(),
 *   principalType: "ServicePrincipal",
 * });
 * yield* Azure.Purview.KafkaConfiguration("notifications", {
 *   account: catalog.accountName,
 *   eventHubId: hub.eventHubId,
 *   eventHubType: "Notification",
 * });
 * ```
 *
 * ### Ingesting Atlas Hooks
 * **Example:** Read hook messages with a dedicated consumer group
 * ```typescript
 * const catalog = yield* Azure.Purview.Account("catalog");
 * const namespace = yield* Azure.EventHub.Namespace("events");
 * const hub = yield* Azure.EventHub.EventHub("hooks", {
 *   namespace: namespace.namespaceName,
 * });
 * const group = yield* Azure.EventHub.ConsumerGroup("purview", {
 *   namespace: namespace.namespaceName,
 *   eventHub: hub.eventHubName,
 * });
 * yield* Azure.Purview.KafkaConfiguration("hooks", {
 *   account: catalog.accountName,
 *   eventHubId: hub.eventHubId,
 *   eventHubType: "Hook",
 *   consumerGroup: group.consumerGroupName,
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `account`, or `resourceGroup` replaces the
 * configuration.
 * :::
 *
 * @resource
 */
export const KafkaConfiguration = GroupedResource<KafkaConfiguration>(
  "Azure.Purview.KafkaConfiguration",
);

type ObservedConfiguration = purview.GetKafkaConfigurationResponse | purview.KafkaConfiguration;

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  kafkaConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    purview.GetKafkaConfiguration({
      subscriptionId,
      resourceGroupName,
      accountName,
      kafkaConfigurationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  observed: ObservedConfiguration,
): KafkaConfiguration["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    kafkaConfigurationName: name,
    kafkaConfigurationId: observed.id ?? "",
    account,
    resourceGroup,
    eventHubId: props.eventHubResourceId,
    eventHubType: props.eventHubType,
    consumerGroup: props.consumerGroup,
    eventHubPartitionId: props.eventHubPartitionId,
    credentialsType: props.credentials?.type,
    credentialsIdentityId: props.credentials?.identityId,
    eventStreamingState: props.eventStreamingState,
  };
};

const desiredProperties = (news: KafkaConfigurationProps): purview.KafkaConfigurationProperties => {
  const credentials: KafkaConfigurationCredentials = news.credentials ?? {
    type: "SystemAssigned",
  };
  return {
    eventHubResourceId: news.eventHubId,
    eventHubType: news.eventHubType,
    consumerGroup: news.consumerGroup,
    eventHubPartitionId: news.eventHubPartitionId,
    // A bring-your-own event hub is the `Azure` streaming type; `Managed`
    // is the account's own namespace (`Account.managedEventHubState`).
    eventStreamingType: "Azure",
    eventStreamingState: news.eventStreamingState ?? "Enabled",
    credentials: {
      type: credentials.type,
      identityId: credentials.type === "UserAssigned" ? credentials.identityId : undefined,
    },
  };
};

const same = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const propertiesDiffer = (
  observed: purview.KafkaConfigurationProperties | undefined,
  desired: purview.KafkaConfigurationProperties,
) =>
  !same(observed?.eventHubResourceId, desired.eventHubResourceId) ||
  !same(observed?.eventHubType, desired.eventHubType) ||
  !same(observed?.consumerGroup, desired.consumerGroup) ||
  !same(observed?.eventHubPartitionId, desired.eventHubPartitionId) ||
  !same(observed?.eventStreamingType, desired.eventStreamingType) ||
  !same(observed?.eventStreamingState, desired.eventStreamingState) ||
  !same(observed?.credentials?.type, desired.credentials?.type) ||
  !same(observed?.credentials?.identityId, desired.credentials?.identityId);

export const KafkaConfigurationProvider = () =>
  Provider.succeed(KafkaConfiguration, {
    stables: ["kafkaConfigurationName", "kafkaConfigurationId", "account", "resourceGroup"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* purview.ListAccountBySubscription.items({ subscriptionId }).pipe(
        Stream.runCollect,
      );
      const owned = Array.from(accounts).flatMap((account) => {
        const group = resourceGroupOf(account.id);
        return hasAnyAlchemyTag(account.tags) &&
          group !== undefined &&
          account.name !== undefined &&
          account.properties?.provisioningState === "Succeeded"
          ? [{ group, name: account.name }]
          : [];
      });
      const configurations = yield* Effect.forEach(owned, ({ group, name }) =>
        purview.ListKafkaConfigurationByAccount.items({
          subscriptionId,
          resourceGroupName: group,
          accountName: name,
        }).pipe(
          Stream.runCollect,
          Effect.map((items) =>
            Array.from(items).flatMap((configuration) =>
              configuration.name === undefined
                ? []
                : [toAttrs(group, name, configuration.name, configuration)],
            ),
          ),
        ),
      );
      return configurations.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.account, output.account) ||
        (news.name !== undefined && !sameName(news.name, output.kafkaConfigurationName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its account.
      if (resourceGroup === undefined || account === undefined) return undefined;
      const name =
        output?.kafkaConfigurationName ?? olds?.name ?? (yield* createKafkaConfigurationName(id));
      const observed = yield* getConfiguration(subscriptionId, resourceGroup, account, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      const owned = yield* accountOwnedByStage(subscriptionId, resourceGroup, account);
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Purview");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.kafkaConfigurationName ?? (yield* createKafkaConfigurationName(id));
      const get = getConfiguration(subscriptionId, resourceGroup, account, name);
      const desired = desiredProperties(news);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a synchronous full upsert of the
      // properties, so one call covers create and every change.
      if (observed === undefined || propertiesDiffer(observed.properties, desired)) {
        yield* purview.KafkaConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          kafkaConfigurationName: name,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `purview kafka configuration ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        purview.DeleteKafkaConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.account,
          kafkaConfigurationName: output.kafkaConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `purview kafka configuration ${output.kafkaConfigurationName}`,
        getConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.kafkaConfigurationName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Purview.Account", "Azure.Resources.ResourceGroup"] },
  });
