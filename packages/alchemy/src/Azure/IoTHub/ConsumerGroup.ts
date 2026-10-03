import * as iothub from "@distilled.cloud/azure/iothub";
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
import { createChildName, iotHubOwnedByStage } from "./Common.ts";

export interface ConsumerGroupProps {
  /** Resource group of the IoT hub. Changing it replaces the consumer group. */
  resourceGroup: string;
  /** Name of the IoT hub. Changing it replaces the consumer group. */
  iotHub: string;
  /**
   * Event Hub-compatible endpoint the consumer group reads. IoT Hub has a
   * single built-in endpoint, `events`. Changing it replaces the consumer
   * group.
   * @default "events"
   */
  eventHubEndpointName?: string;
  /**
   * Consumer group name: 1-50 letters, digits, periods, hyphens, and
   * underscores. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the consumer group. The built-in
   * `$Default` group is never managed.
   */
  name?: string;
}

export interface ConsumerGroup extends Resource<
  "Azure.IoTHub.ConsumerGroup",
  ConsumerGroupProps,
  {
    /** Name of the consumer group. */
    consumerGroupName: string;
    /** ARM resource ID of the consumer group. */
    consumerGroupId: string;
    /** Event Hub-compatible endpoint the consumer group reads. */
    eventHubEndpointName: string;
    /** IoT hub of the consumer group. */
    iotHub: string;
    /** Resource group of the IoT hub. */
    resourceGroup: string;
    /** Time the consumer group was created. */
    created: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A consumer group on an IoT hub's built-in Event Hub-compatible `events`
 * endpoint — an independent read position for one application reading
 * device-to-cloud telemetry.
 *
 * Consumer groups carry no tags or metadata; they count as owned when the
 * parent hub carries this stack's and stage's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/iot-hub/iot-hub-devguide-messages-read-builtin
 *
 * ### Creating a Consumer Group
 * **Example:** One consumer group per reading service
 * ```typescript
 * const hub = yield* Azure.IoTHub.IotHub("devices", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const analytics = yield* Azure.IoTHub.ConsumerGroup("analytics", {
 *   resourceGroup: group.resourceGroupName,
 *   iotHub: hub.iotHubName,
 * });
 * ```
 *
 * **Example:** Explicit name
 * ```typescript
 * const alerts = yield* Azure.IoTHub.ConsumerGroup("alerts", {
 *   resourceGroup: group.resourceGroupName,
 *   iotHub: hub.iotHubName,
 *   name: "alerts",
 * });
 * ```
 *
 * @resource
 */
export const ConsumerGroup = Resource<ConsumerGroup>(
  "Azure.IoTHub.ConsumerGroup",
);

const getConsumerGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  eventHubEndpointName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    iothub.GetIotHubResourceEventHubConsumerGroup({
      subscriptionId,
      resourceGroupName,
      resourceName,
      eventHubEndpointName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  iotHub: string,
  eventHubEndpointName: string,
  name: string,
  group: iothub.EventHubConsumerGroupInfo,
): ConsumerGroup["Attributes"] => {
  const created = group.properties?.created;
  return {
    consumerGroupName: name,
    consumerGroupId: group.id ?? "",
    eventHubEndpointName,
    iotHub,
    resourceGroup,
    created: typeof created === "string" ? created : undefined,
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

export const ConsumerGroupProvider = () =>
  Provider.succeed(ConsumerGroup, {
    stables: [
      "consumerGroupName",
      "consumerGroupId",
      "eventHubEndpointName",
      "iotHub",
      "resourceGroup",
    ],

    // Consumer groups live inside a hub; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.iotHub) !== lower(output.iotHub) ||
        lower(news.eventHubEndpointName ?? "events") !==
          lower(output.eventHubEndpointName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.consumerGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const iotHub = output?.iotHub ?? olds?.iotHub;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its hub.
      if (resourceGroup === undefined || iotHub === undefined) {
        return undefined;
      }
      const endpoint =
        output?.eventHubEndpointName ?? olds?.eventHubEndpointName ?? "events";
      const name =
        output?.consumerGroupName ??
        olds?.name ??
        (yield* createChildName(id, 50));
      const observed = yield* getConsumerGroup(
        subscriptionId,
        resourceGroup,
        iotHub,
        endpoint,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, iotHub, endpoint, name, observed);
      return (yield* iotHubOwnedByStage(subscriptionId, resourceGroup, iotHub))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Devices");
      const { resourceGroup, iotHub } = news;
      const endpoint = news.eventHubEndpointName ?? "events";
      const name =
        news.name ??
        output?.consumerGroupName ??
        (yield* createChildName(id, 50));
      const get = getConsumerGroup(
        subscriptionId,
        resourceGroup,
        iotHub,
        endpoint,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure: existence-only, nothing mutable to sync.
      if (observed === undefined) {
        yield* iothub.CreateIotHubResourceEventHubConsumerGroup({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: iotHub,
          eventHubEndpointName: endpoint,
          name,
          properties: { name },
        });
      }

      const fresh = yield* waitForProvisioned(
        `iot hub consumer group ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, iotHub, endpoint, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        iothub.DeleteIotHubResourceEventHubConsumerGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.iotHub,
          eventHubEndpointName: output.eventHubEndpointName,
          name: output.consumerGroupName,
        }),
      );
      yield* waitUntilGone(
        `iot hub consumer group ${output.consumerGroupName}`,
        getConsumerGroup(
          subscriptionId,
          output.resourceGroup,
          output.iotHub,
          output.eventHubEndpointName,
          output.consumerGroupName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.IoTHub.IotHub", "Azure.Resources.ResourceGroup"],
    },
  });
