import * as Azure from "@alchemy.run/azure";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:eventgrid", "live"];

export const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound", "NotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

export interface PartnerChainOptions {
  /** Tags of the partner registration. */
  registrationTags?: Record<string, string>;
  /** Namespace settings. */
  namespace?: {
    minimumTlsVersionAllowed?: "1.0" | "1.1" | "1.2";
    partnerTopicRoutingMode?: Azure.EventGrid.PartnerTopicRoutingMode;
    tags?: Record<string, string>;
  };
  /** Deploy a channel with these advertised event types. */
  channel?: {
    eventTypes: Record<string, Azure.EventGrid.PartnerEventType>;
    source?: string;
  };
  /** Activate the channel's partner topic with these tags. */
  topic?: { tags: Record<string, string> };
  /** Subscribe a Storage queue to the partner topic with these event types. */
  subscription?: { eventTypes: string[] };
}

/**
 * Partner events end to end in one resource group of the testing
 * subscription: the publisher (registration, namespace, channel) and the
 * subscriber (configuration authorizing the registration, partner topic,
 * event subscription).
 */
export const partnerChain = (options: PartnerChainOptions = {}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const registration = yield* Azure.EventGrid.PartnerRegistration("Registration", {
      resourceGroup: group.resourceGroupName,
      tags: options.registrationTags,
    });
    const partners = yield* Azure.EventGrid.PartnerConfiguration("Partners", {
      resourceGroup: group.resourceGroupName,
      authorizedPartners: [
        { partnerRegistrationImmutableId: registration.partnerRegistrationImmutableId },
      ],
    });
    const namespace = yield* Azure.EventGrid.PartnerNamespace("Publisher", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      partnerRegistration: registration.partnerRegistrationId,
      partnerTopicRoutingMode: options.namespace?.partnerTopicRoutingMode ?? "ChannelNameHeader",
      minimumTlsVersionAllowed: options.namespace?.minimumTlsVersionAllowed,
      tags: options.namespace?.tags,
    });
    const channel = options.channel
      ? yield* Azure.EventGrid.Channel("Orders", {
          resourceGroup: group.resourceGroupName,
          partnerNamespace: namespace.partnerNamespaceName,
          partnerTopic: {
            // The configuration's resource group orders the channel after
            // the authorization.
            resourceGroup: partners.resourceGroup,
            source: options.channel.source ?? "contoso/tenants/alchemy-test",
          },
          eventTypes: options.channel.eventTypes,
          messageForActivation: "Activate to receive Contoso order events.",
        })
      : undefined;
    const topic =
      channel && options.topic
        ? yield* Azure.EventGrid.PartnerTopic("OrdersTopic", {
            resourceGroup: channel.partnerTopicResourceGroup,
            name: channel.partnerTopicName,
            tags: options.topic.tags,
          })
        : undefined;
    const subscriptionOptions = options.subscription;
    const delivery =
      topic && subscriptionOptions
        ? yield* Effect.gen(function* () {
            const account = yield* Azure.Storage.StorageAccount("Inbox", {
              resourceGroup: group.resourceGroupName,
            });
            const queue = yield* Azure.Storage.Queue("OrdersQueue", {
              resourceGroup: group.resourceGroupName,
              storageAccount: account.storageAccountName,
            });
            const sub = yield* Azure.EventGrid.PartnerTopicEventSubscription("OrdersCreated", {
              resourceGroup: group.resourceGroupName,
              partnerTopic: topic.partnerTopicName,
              destination: {
                endpointType: "StorageQueue",
                resourceId: account.storageAccountId,
                queueName: queue.queueName,
              },
              filter: { includedEventTypes: subscriptionOptions.eventTypes },
            });
            return { account, queue, sub };
          })
        : undefined;
    return { group, registration, partners, namespace, channel, topic, sub: delivery?.sub };
  });
