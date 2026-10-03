import * as confluent from "@distilled.cloud/azure/confluent";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalJson,
  isOrganizationOwnedByStack,
  type OrganizationChildProps,
  sameName,
} from "./common.ts";

export interface TopicProps extends OrganizationChildProps {
  /** Environment ID that holds the cluster. Changing it replaces the topic. */
  environment: string;
  /** Cluster ID that holds the topic. Changing it replaces the topic. */
  cluster: string;
  /**
   * Kafka topic name, 1-249 letters, digits, `.`, `_`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the topic.
   */
  name?: string;
  /**
   * Number of partitions. Changing it replaces the topic.
   * @default the cluster default (6)
   */
  partitionsCount?: number;
  /**
   * Replication factor. Changing it replaces the topic.
   * @default the cluster default (3)
   */
  replicationFactor?: number;
  /**
   * Kafka topic configuration overrides, e.g.
   * `{ "cleanup.policy": "compact", "retention.ms": "86400000" }`.
   */
  configs?: Record<string, string>;
}

export interface Topic extends Resource<
  "Azure.Confluent.Topic",
  TopicProps,
  {
    /** Kafka topic name (ARM resource name). */
    topicName: string;
    /** Cluster ID that holds the topic. */
    cluster: string;
    /** Environment ID that holds the cluster. */
    environment: string;
    /** Name of the Confluent organization. */
    organization: string;
    /** Resource group of the organization. */
    resourceGroup: string;
    /** ARM resource ID of the topic. */
    topicResourceId: string;
    /** Topic ID returned by Confluent. */
    topicId: string | undefined;
    /** Confluent resource name (CRN) of the topic. */
    resourceName: string | undefined;
    /** Number of partitions. */
    partitionsCount: number | undefined;
    /** Replication factor. */
    replicationFactor: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A Kafka topic in a Confluent Cloud cluster of an Azure-managed Confluent
 * organization.
 *
 * Topics carry no tags, so Alchemy ownership is inherited from the
 * organization's tags. Partition count and replication factor are fixed at
 * creation; configuration overrides are updated in place.
 *
 * @see https://docs.confluent.io/cloud/current/topics/overview.html
 *
 * ### Creating a Topic
 * **Example:** Topic with six partitions
 * ```typescript
 * const topic = yield* Azure.Confluent.Topic("orders", {
 *   resourceGroup: org.resourceGroup,
 *   organization: org.organizationName,
 *   environment: environment.environmentId,
 *   cluster: cluster.clusterId,
 *   name: "orders",
 *   partitionsCount: 6,
 * });
 * ```
 *
 * **Example:** Compacted topic
 * ```typescript
 * const topic = yield* Azure.Confluent.Topic("customers", {
 *   resourceGroup: org.resourceGroup,
 *   organization: org.organizationName,
 *   environment: environment.environmentId,
 *   cluster: cluster.clusterId,
 *   configs: { "cleanup.policy": "compact" },
 * });
 * ```
 *
 * @resource
 */
export const Topic = Resource<Topic>("Azure.Confluent.Topic");

type ObservedTopic = confluent.GetTopicResponse;

const createTopicName = (id: string) =>
  createPhysicalName({ id, maxLength: 249 });

interface TopicLocation {
  resourceGroup: string;
  organization: string;
  environment: string;
  cluster: string;
}

const getTopic = (
  subscriptionId: string,
  location: TopicLocation,
  topicName: string,
) =>
  orUndefinedIfNotFound(
    confluent.GetTopic({
      subscriptionId,
      resourceGroupName: location.resourceGroup,
      organizationName: location.organization,
      environmentId: location.environment,
      clusterId: location.cluster,
      topicName,
    }),
  );

const toNumber = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : Number(value);

const toAttrs = (
  location: TopicLocation,
  name: string,
  observed: ObservedTopic,
): Topic["Attributes"] => ({
  topicName: name,
  cluster: location.cluster,
  environment: location.environment,
  organization: location.organization,
  resourceGroup: location.resourceGroup,
  topicResourceId: observed.id ?? "",
  topicId: observed.properties?.topicId,
  resourceName: observed.properties?.metadata?.resourceName,
  partitionsCount: toNumber(observed.properties?.partitionsCount),
  replicationFactor: toNumber(observed.properties?.replicationFactor),
});

const configsOf = (configs: confluent.TopicProperties["inputConfigs"]) =>
  Object.fromEntries(
    (configs ?? []).flatMap((c) =>
      c.name === undefined ? [] : [[c.name, c.value ?? ""] as const],
    ),
  );

const parentChanged = (news: TopicLocation, output: TopicLocation) =>
  !sameName(news.resourceGroup, output.resourceGroup) ||
  !sameName(news.organization, output.organization) ||
  !sameName(news.environment, output.environment) ||
  !sameName(news.cluster, output.cluster);

export const TopicProvider = () =>
  Provider.succeed(Topic, {
    stables: [
      "topicName",
      "cluster",
      "environment",
      "organization",
      "resourceGroup",
      "topicResourceId",
      "topicId",
    ],

    // Topics are deleted with their cluster; ownership lives on the
    // organization, which `list` already covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        parentChanged(news, output) ||
        (news.name !== undefined && news.name !== output.topicName) ||
        (news.partitionsCount !== undefined &&
          output.partitionsCount !== undefined &&
          news.partitionsCount !== output.partitionsCount) ||
        (news.replicationFactor !== undefined &&
          output.replicationFactor !== undefined &&
          news.replicationFactor !== output.replicationFactor)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const organization = output?.organization ?? olds?.organization;
      const environment = output?.environment ?? olds?.environment;
      const cluster = output?.cluster ?? olds?.cluster;
      if (
        resourceGroup === undefined ||
        organization === undefined ||
        environment === undefined ||
        cluster === undefined
      ) {
        return undefined;
      }
      const location = { resourceGroup, organization, environment, cluster };
      const name =
        output?.topicName ?? olds?.name ?? (yield* createTopicName(id));
      const observed = yield* getTopic(subscriptionId, location, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(location, name, observed);
      return (yield* isOrganizationOwnedByStack(
        subscriptionId,
        resourceGroup,
        organization,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Confluent");
      const location: TopicLocation = {
        resourceGroup: news.resourceGroup,
        organization: news.organization,
        environment: news.environment,
        cluster: news.cluster,
      };
      const name =
        news.name ?? output?.topicName ?? (yield* createTopicName(id));
      const desiredConfigs = news.configs ?? {};

      // Observe.
      let observed = yield* getTopic(subscriptionId, location, name);

      // Ensure + sync configs. GET does not always echo the input configs;
      // fall back to the last applied configs as the observed baseline.
      const observedConfigs =
        observed?.properties?.inputConfigs !== undefined
          ? configsOf(observed.properties.inputConfigs)
          : (olds?.configs ?? {});
      if (
        observed === undefined ||
        canonicalJson(observedConfigs) !== canonicalJson(desiredConfigs)
      ) {
        yield* confluent.CreateTopic({
          subscriptionId,
          resourceGroupName: location.resourceGroup,
          organizationName: location.organization,
          environmentId: location.environment,
          clusterId: location.cluster,
          topicName: name,
          properties: {
            partitionsCount:
              observed?.properties?.partitionsCount ??
              (news.partitionsCount === undefined
                ? undefined
                : String(news.partitionsCount)),
            replicationFactor:
              observed?.properties?.replicationFactor ??
              (news.replicationFactor === undefined
                ? undefined
                : String(news.replicationFactor)),
            inputConfigs: Object.entries(desiredConfigs).map(
              ([configName, value]) => ({ name: configName, value }),
            ),
          },
        });
        observed = yield* waitForTopic(subscriptionId, location, name);
      }

      return toAttrs(location, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        confluent.DeleteTopic({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          organizationName: output.organization,
          environmentId: output.environment,
          clusterId: output.cluster,
          topicName: output.topicName,
        }),
      );
      yield* waitUntilGone(
        `Confluent topic ${output.topicName}`,
        getTopic(subscriptionId, output, output.topicName),
      );
    }),

    nuke: { dependsOn: ["Azure.Confluent.Cluster"] },
  });

/** A freshly created topic can take a moment to become readable. */
const waitForTopic = (
  subscriptionId: string,
  location: TopicLocation,
  name: string,
) =>
  waitForProvisioned(
    `Confluent topic ${name}`,
    getTopic(subscriptionId, location, name),
    () => undefined,
    { interval: "3 seconds", times: 20 },
  );
