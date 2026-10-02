import * as logic from "@distilled.cloud/azure/logic";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  artifactDiffers,
  artifactMetadata,
  createLogicName,
  definedOnly,
  HASH_KEY,
  hashOf,
  isOwnedByMetadata,
  userMetadata,
} from "./LogicShared.ts";

/** When a batch is released. At least one criterion is required. */
export interface IntegrationAccountBatchReleaseCriteria {
  /** Release after this many messages. */
  messageCount?: number;
  /** Release after this many bytes. */
  batchSize?: number;
  /** Release on a schedule. */
  recurrence?: {
    /** Recurrence unit. */
    frequency?:
      | "Second"
      | "Minute"
      | "Hour"
      | "Day"
      | "Week"
      | "Month"
      | "Year";
    /** Number of units between releases. */
    interval?: number;
    /** ISO 8601 start time. */
    startTime?: string;
    /** ISO 8601 end time. */
    endTime?: string;
    /** Windows time zone ID. */
    timeZone?: string;
  };
}

export interface IntegrationAccountBatchConfigurationProps {
  /** Resource group of the integration account. Changing it replaces the batch configuration. */
  resourceGroup: string;
  /** Name of the integration account. Changing it replaces the batch configuration. */
  integrationAccount: string;
  /**
   * Batch configuration name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the batch configuration.
   */
  name?: string;
  /** Name of the batch group that batch-receiver workflows release into. */
  batchGroupName: string;
  /** When the batch is released. */
  releaseCriteria: IntegrationAccountBatchReleaseCriteria;
  /**
   * User metadata. Alchemy adds `alchemy::*` ownership and hash keys
   * because artifacts do not return tags.
   */
  metadata?: Record<string, unknown>;
}

export interface IntegrationAccountBatchConfiguration extends Resource<
  "Azure.Logic.IntegrationAccountBatchConfiguration",
  IntegrationAccountBatchConfigurationProps,
  {
    /** Name of the batch configuration. */
    batchConfigurationName: string;
    /** Name of the integration account. */
    integrationAccount: string;
    /** Resource group of the integration account. */
    resourceGroup: string;
    /** ARM resource ID of the batch configuration. */
    batchConfigurationId: string;
    /** Name of the batch group. */
    batchGroupName: string;
    /** Time the batch configuration was last changed. */
    changedTime: string | undefined;
    /** User metadata (Alchemy keys stripped). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A batch configuration in a Logic Apps integration account: a named
 * batch group and the criteria (message count, size, or schedule) that
 * release batched messages to batch-receiver workflows.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-batch-process-send-receive-messages
 *
 * ### Configuring a Batch
 * **Example:** Release every 10 messages
 * ```typescript
 * const orders = yield* Azure.Logic.IntegrationAccountBatchConfiguration("orders", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   batchGroupName: "orders",
 *   releaseCriteria: { messageCount: 10 },
 * });
 * ```
 *
 * **Example:** Release hourly or at 1 MB
 * ```typescript
 * const hourly = yield* Azure.Logic.IntegrationAccountBatchConfiguration("hourly", {
 *   resourceGroup: group.resourceGroupName,
 *   integrationAccount: account.integrationAccountName,
 *   batchGroupName: "hourly",
 *   releaseCriteria: {
 *     batchSize: 1_048_576,
 *     recurrence: { frequency: "Hour", interval: 1 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const IntegrationAccountBatchConfiguration =
  Resource<IntegrationAccountBatchConfiguration>(
    "Azure.Logic.IntegrationAccountBatchConfiguration",
  );

const getBatchConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  integrationAccountName: string,
  batchConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetIntegrationAccountBatchConfiguration({
      subscriptionId,
      resourceGroupName,
      integrationAccountName,
      batchConfigurationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  integrationAccount: string,
  name: string,
  observed: logic.GetIntegrationAccountBatchConfigurationResponse,
): IntegrationAccountBatchConfiguration["Attributes"] => ({
  batchConfigurationName: name,
  integrationAccount,
  resourceGroup,
  batchConfigurationId: observed.id ?? "",
  batchGroupName: observed.properties.batchGroupName,
  changedTime: observed.properties.changedTime,
  metadata: userMetadata(observed.properties.metadata),
});

export const IntegrationAccountBatchConfigurationProvider = () =>
  Provider.succeed(IntegrationAccountBatchConfiguration, {
    stables: [
      "batchConfigurationName",
      "integrationAccount",
      "resourceGroup",
      "batchConfigurationId",
    ],

    // Artifacts live inside an integration account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.integrationAccount.toLowerCase() !==
          output.integrationAccount.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.batchConfigurationName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const integrationAccount =
        output?.integrationAccount ?? olds?.integrationAccount;
      if (resourceGroup === undefined || integrationAccount === undefined) {
        return undefined;
      }
      const name =
        output?.batchConfigurationName ??
        olds?.name ??
        (yield* createLogicName(id));
      const observed = yield* getBatchConfiguration(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, integrationAccount, name, observed);
      return (yield* isOwnedByMetadata(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const { resourceGroup, integrationAccount } = news;
      const name =
        news.name ??
        output?.batchConfigurationName ??
        (yield* createLogicName(id));
      const properties = {
        batchGroupName: news.batchGroupName,
        releaseCriteria: news.releaseCriteria,
      };
      const metadata = yield* artifactMetadata(id, news.metadata, {
        [HASH_KEY]: yield* hashOf({ properties, metadata: news.metadata }),
      });

      // Observe.
      let observed = yield* getBatchConfiguration(
        subscriptionId,
        resourceGroup,
        integrationAccount,
        name,
      );

      // Ensure + sync: the PUT is a synchronous full replacement; changes
      // to fields Azure does not echo surface through the metadata hash.
      if (
        observed === undefined ||
        artifactDiffers(
          observed.properties,
          metadata,
          definedOnly({
            batchGroupName: properties.batchGroupName,
            releaseCriteria: properties.releaseCriteria,
          }),
        )
      ) {
        observed =
          yield* logic.IntegrationAccountBatchConfigurationsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            integrationAccountName: integrationAccount,
            batchConfigurationName: name,
            properties: { ...properties, metadata },
          });
      }

      return toAttrs(resourceGroup, integrationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteIntegrationAccountBatchConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          integrationAccountName: output.integrationAccount,
          batchConfigurationName: output.batchConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `integration account batch configuration ${output.batchConfigurationName}`,
        getBatchConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.integrationAccount,
          output.batchConfigurationName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Logic.IntegrationAccount"] },
  });
