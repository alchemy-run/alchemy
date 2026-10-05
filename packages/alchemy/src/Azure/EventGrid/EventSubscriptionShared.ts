import type * as eventgrid from "@distilled.cloud/azure/eventgrid";
import * as Effect from "effect/Effect";
import { stackAndStage, waitForProvisioned } from "../Arm.ts";

/** Where Event Grid delivers events. */
export type EventSubscriptionDestination =
  | {
      /** Deliver to an Azure Storage queue. */
      endpointType: "StorageQueue";
      /** ARM ID of the storage account. */
      resourceId: string;
      /** Name of the queue. */
      queueName: string;
      /** Time-to-live of queue messages in seconds (`-1` = never expire). */
      queueMessageTimeToLiveInSeconds?: number;
    }
  | {
      /** Deliver to an HTTPS webhook (must answer the validation handshake). */
      endpointType: "WebHook";
      /** Webhook URL. */
      endpointUrl: string;
      /** Maximum events per batch (1-5000). */
      maxEventsPerBatch?: number;
      /** Preferred batch size in kilobytes (1-1024). */
      preferredBatchSizeInKilobytes?: number;
      /** Entra tenant ID used to obtain a bearer token for delivery. */
      azureActiveDirectoryTenantId?: string;
      /** Entra application ID or URI used to obtain a bearer token. */
      azureActiveDirectoryApplicationIdOrUri?: string;
    }
  | {
      /** Deliver to an Azure Function. */
      endpointType: "AzureFunction";
      /** ARM ID of the function, e.g. `.../sites/{app}/functions/{name}`. */
      resourceId: string;
      /** Maximum events per batch (1-5000). */
      maxEventsPerBatch?: number;
      /** Preferred batch size in kilobytes (1-1024). */
      preferredBatchSizeInKilobytes?: number;
    }
  | {
      /** Deliver to an Event Hub, Service Bus queue/topic, Relay hybrid connection, or Event Grid namespace topic. */
      endpointType:
        | "EventHub"
        | "ServiceBusQueue"
        | "ServiceBusTopic"
        | "HybridConnection"
        | "NamespaceTopic";
      /** ARM ID of the destination resource. */
      resourceId: string;
    };

/** Identity Event Grid uses to deliver events (managed-identity delivery). */
export interface EventSubscriptionDeliveryIdentity {
  /** Identity of the topic to use. */
  type: "SystemAssigned" | "UserAssigned";
  /** ARM ID of the user-assigned identity (with `type: "UserAssigned"`). */
  userAssignedIdentity?: string;
}

/** Advanced filter on an event field. */
export interface EventSubscriptionAdvancedFilter {
  /** Operator, e.g. `StringIn`, `NumberGreaterThan`, `BoolEquals`. */
  operatorType: eventgrid.AdvancedFilterOperatorType;
  /** Event field to filter on, e.g. `data.api` or `subject`. */
  key: string;
  /** Single comparison value (`NumberGreaterThan`, `BoolEquals`, …). */
  value?: number | boolean;
  /** Comparison values (`StringIn`, `NumberIn`, `NumberInRange`, …). */
  values?: (string | number | number[])[];
}

/** Which events a subscription receives. */
export interface EventSubscriptionFilter {
  /** Event types to deliver. Omit for all event types. */
  includedEventTypes?: string[];
  /** Deliver only events whose subject starts with this prefix. */
  subjectBeginsWith?: string;
  /** Deliver only events whose subject ends with this suffix. */
  subjectEndsWith?: string;
  /** Match `subjectBeginsWith`/`subjectEndsWith` case-sensitively. @default false */
  isSubjectCaseSensitive?: boolean;
  /** Evaluate advanced filters against array values. @default false */
  enableAdvancedFilteringOnArrays?: boolean;
  /** Advanced filters (all must match). */
  advancedFilters?: EventSubscriptionAdvancedFilter[];
}

/** Props shared by every event-subscription resource. */
export interface EventSubscriptionSettings {
  /**
   * Event subscription name: 3-64 letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the subscription.
   */
  name?: string;
  /** Where events are delivered. */
  destination: EventSubscriptionDestination;
  /**
   * Deliver with the topic's managed identity instead of keys. The topic
   * (or system topic) must have that identity, and the identity needs a
   * role on the destination.
   */
  deliveryIdentity?: EventSubscriptionDeliveryIdentity;
  /** Which events are delivered. */
  filter?: EventSubscriptionFilter;
  /** User labels. Alchemy adds an ownership label (`alchemy:{stack}/{stage}/{id}`). */
  labels?: string[];
  /** Expiration time (ISO 8601). Azure deletes the subscription after it. */
  expirationTimeUtc?: string;
  /**
   * Schema of delivered events. Immutable: changing it replaces the
   * subscription.
   * @default "EventGridSchema"
   */
  eventDeliverySchema?:
    | "EventGridSchema"
    | "CustomInputSchema"
    | "CloudEventSchemaV1_0";
  /** Delivery retry policy. */
  retryPolicy?: {
    /** Maximum delivery attempts (1-30). @default 30 */
    maxDeliveryAttempts?: number;
    /** Time-to-live of an event in minutes (1-1440). @default 1440 */
    eventTimeToLiveInMinutes?: number;
  };
  /** Blob container that receives undeliverable events. */
  deadLetterDestination?: {
    /** ARM ID of the storage account. */
    resourceId: string;
    /** Name of the blob container. */
    blobContainerName: string;
  };
}

/** Attributes shared by every event-subscription resource. */
export interface EventSubscriptionAttributes {
  /** Name of the event subscription. */
  eventSubscriptionName: string;
  /** ARM resource ID of the event subscription. */
  eventSubscriptionId: string;
  /** ARM ID of the topic the subscription receives events from. */
  topic: string | undefined;
  /** Destination endpoint type. */
  endpointType: string | undefined;
  /** Schema of delivered events. */
  eventDeliverySchema: string;
  /** User labels (Alchemy ownership label stripped). */
  labels: string[];
}

export type ObservedSubscription = Pick<
  eventgrid.EventSubscription,
  "id" | "properties"
>;

/** Patchable fields of an event subscription (the PATCH body). */
export type EventSubscriptionPatch = Omit<
  eventgrid.UpdateEventSubscriptionRequest,
  "scope" | "eventSubscriptionName"
>;

const MARKER_PREFIX = "alchemy:";

/** Ownership label `alchemy:{stack}/{stage}/{id}`; subscriptions have no tags. */
export const ownershipLabel = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `${MARKER_PREFIX}${stack}/${stage}/${id}`;
});

export const isOwnedSubscription = Effect.fn(function* (
  id: string,
  observed: ObservedSubscription,
) {
  const marker = yield* ownershipLabel(id);
  return (observed.properties?.labels ?? []).includes(marker);
});

export const hasAnyOwnershipLabel = (observed: ObservedSubscription) =>
  (observed.properties?.labels ?? []).some((label) =>
    label.startsWith(MARKER_PREFIX),
  );

export const toSubscriptionAttrs = (
  name: string,
  observed: ObservedSubscription,
): EventSubscriptionAttributes => ({
  eventSubscriptionName: name,
  eventSubscriptionId: observed.id ?? "",
  topic: observed.properties?.topic,
  endpointType:
    observed.properties?.destination?.endpointType ??
    observed.properties?.deliveryWithResourceIdentity?.destination
      ?.endpointType,
  eventDeliverySchema:
    observed.properties?.eventDeliverySchema ?? "EventGridSchema",
  labels: (observed.properties?.labels ?? []).filter(
    (label) => !label.startsWith(MARKER_PREFIX),
  ),
});

export const toWireDestination = (
  destination: EventSubscriptionDestination,
): eventgrid.EventSubscriptionDestination => {
  const { endpointType, ...properties } = destination;
  return { endpointType, properties };
};

/** Desired subscription body in wire form. */
export const desiredSubscription = Effect.fn(function* (
  id: string,
  settings: EventSubscriptionSettings,
) {
  const marker = yield* ownershipLabel(id);
  const destination = toWireDestination(settings.destination);
  const body: eventgrid.EventSubscriptionPropertiesInput = {
    destination: settings.deliveryIdentity ? undefined : destination,
    deliveryWithResourceIdentity: settings.deliveryIdentity
      ? { identity: settings.deliveryIdentity, destination }
      : undefined,
    filter: settings.filter,
    labels: [...(settings.labels ?? []), marker],
    expirationTimeUtc: settings.expirationTimeUtc,
    eventDeliverySchema: settings.eventDeliverySchema ?? "EventGridSchema",
    retryPolicy: settings.retryPolicy,
    deadLetterDestination: settings.deadLetterDestination
      ? {
          endpointType: "StorageBlob",
          properties: settings.deadLetterDestination,
        }
      : undefined,
  };
  return body;
});

const lowerType = (value: string | undefined) => value?.toLowerCase();

/**
 * Whether the observed destination lacks any desired property. The service
 * fills in defaults (batch sizes, TTLs) and hides webhook URLs, so only the
 * desired keys are compared; the webhook URL is compared to `fullUrl`.
 */
export const destinationDiffers = (
  observed: { endpointType: string; properties?: unknown } | undefined,
  desired: { endpointType: string; properties?: unknown } | undefined,
  fullUrl: string | undefined,
) => {
  if (desired === undefined) return false;
  if (lowerType(observed?.endpointType) !== lowerType(desired.endpointType)) {
    return true;
  }
  const have = (observed?.properties ?? {}) as Record<string, unknown>;
  const want = (desired.properties ?? {}) as Record<string, unknown>;
  return Object.entries(want).some(([key, value]) => {
    if (value === undefined) return false;
    const current = key === "endpointUrl" ? fullUrl : have[key];
    if (typeof value === "string" && typeof current === "string") {
      return key === "resourceId"
        ? value.toLowerCase() !== current.toLowerCase()
        : value !== current;
    }
    return JSON.stringify(value) !== JSON.stringify(current);
  });
};

const normalizeFilter = (
  filter: eventgrid.EventSubscriptionFilter | undefined,
) =>
  JSON.stringify({
    includedEventTypes: [...(filter?.includedEventTypes ?? [])].sort(),
    subjectBeginsWith: filter?.subjectBeginsWith ?? "",
    subjectEndsWith: filter?.subjectEndsWith ?? "",
    isSubjectCaseSensitive: filter?.isSubjectCaseSensitive ?? false,
    enableAdvancedFilteringOnArrays:
      filter?.enableAdvancedFilteringOnArrays ?? false,
    advancedFilters: (filter?.advancedFilters ?? []).map((f) => ({
      operatorType: f.operatorType,
      key: f.key,
      value: f.value,
      values: f.values,
    })),
  });

const sortedJson = (values: readonly string[] | undefined) =>
  JSON.stringify([...(values ?? [])].sort());

/** The PATCH delta between the observed subscription and the desired body. */
export const subscriptionDelta = (
  observed: ObservedSubscription,
  desired: eventgrid.EventSubscriptionPropertiesInput,
  fullUrl: string | undefined,
): EventSubscriptionPatch => {
  const props = observed.properties ?? {};
  const patch: EventSubscriptionPatch = {};
  if (
    desired.destination !== undefined &&
    (props.deliveryWithResourceIdentity !== undefined ||
      destinationDiffers(props.destination, desired.destination, fullUrl))
  ) {
    patch.destination = desired.destination;
  }
  const withIdentity = desired.deliveryWithResourceIdentity;
  if (withIdentity !== undefined) {
    const have = props.deliveryWithResourceIdentity;
    if (
      have === undefined ||
      lowerType(have.identity?.type) !==
        lowerType(withIdentity.identity?.type) ||
      lowerType(have.identity?.userAssignedIdentity) !==
        lowerType(withIdentity.identity?.userAssignedIdentity) ||
      destinationDiffers(have.destination, withIdentity.destination, fullUrl)
    ) {
      patch.deliveryWithResourceIdentity = withIdentity;
    }
  }
  if (normalizeFilter(props.filter) !== normalizeFilter(desired.filter)) {
    patch.filter = desired.filter ?? {};
  }
  if (sortedJson(props.labels) !== sortedJson(desired.labels)) {
    patch.labels = desired.labels;
  }
  if (
    desired.expirationTimeUtc !== undefined &&
    Date.parse(desired.expirationTimeUtc) !==
      Date.parse(props.expirationTimeUtc ?? "")
  ) {
    patch.expirationTimeUtc = desired.expirationTimeUtc;
  }
  const retry = desired.retryPolicy;
  if (
    retry !== undefined &&
    ((retry.maxDeliveryAttempts !== undefined &&
      retry.maxDeliveryAttempts !== props.retryPolicy?.maxDeliveryAttempts) ||
      (retry.eventTimeToLiveInMinutes !== undefined &&
        retry.eventTimeToLiveInMinutes !==
          props.retryPolicy?.eventTimeToLiveInMinutes))
  ) {
    patch.retryPolicy = { ...props.retryPolicy, ...retry };
  }
  if (
    desired.deadLetterDestination !== undefined &&
    destinationDiffers(
      props.deadLetterDestination,
      desired.deadLetterDestination,
      undefined,
    )
  ) {
    patch.deadLetterDestination = desired.deadLetterDestination;
  }
  return patch;
};

/** Operations of one event-subscription URI form. */
export interface SubscriptionOps<E, R> {
  readonly label: string;
  readonly get: Effect.Effect<ObservedSubscription | undefined, E, R>;
  readonly create: (
    properties: eventgrid.EventSubscriptionPropertiesInput,
  ) => Effect.Effect<unknown, E, R>;
  readonly update: (
    patch: EventSubscriptionPatch,
  ) => Effect.Effect<unknown, E, R>;
  /** Full webhook URL (write-only on GET); only called for webhooks. */
  readonly fullUrl: Effect.Effect<string | undefined, E, R>;
}

/**
 * Observe → ensure → sync for any event-subscription URI form. Blocks until
 * the subscription is `Succeeded`; an unvalidated webhook stays in
 * `AwaitingManualAction` and surfaces as `ProvisioningTimedOut`.
 */
export const reconcileSubscription = <E, R>(
  ops: SubscriptionOps<E, R>,
  desired: eventgrid.EventSubscriptionPropertiesInput,
) =>
  Effect.gen(function* () {
    const stateOf = (sub: ObservedSubscription) =>
      sub.properties?.provisioningState;
    const budget = { interval: "3 seconds", times: 40 } as const;

    // Observe.
    let observed = yield* ops.get;

    // Ensure.
    if (observed === undefined) {
      yield* ops.create(desired);
    }
    observed = yield* waitForProvisioned(ops.label, ops.get, stateOf, budget);

    // Sync against observed state; PATCH only the delta.
    const endpointType = (
      desired.destination ?? desired.deliveryWithResourceIdentity?.destination
    )?.endpointType;
    const fullUrl =
      lowerType(endpointType) === "webhook" ? yield* ops.fullUrl : undefined;
    const patch = subscriptionDelta(observed, desired, fullUrl);
    if (Object.keys(patch).length > 0) {
      yield* ops.update(patch);
      observed = yield* waitForProvisioned(ops.label, ops.get, stateOf, budget);
    }
    return observed;
  });
