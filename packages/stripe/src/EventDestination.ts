import { unwrapRedactedDeep } from "@distilled.cloud/core/protocol-rest";
import {
  CreateCoreEventDestination,
  CreateCoreEventDestinationDisable,
  CreateCoreEventDestinationEnable,
  DeleteCoreEventDestination,
  GetCoreEventDestination,
  GetCoreEventDestinations,
  UpdateCoreEventDestination,
  type V2CoreEventDestination,
} from "@distilled.cloud/stripe/stripe";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import { arrayEquals } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { atSpecApiVersion } from "./internal/version.ts";
import {
  alchemyMetadataKeys,
  createInternalMetadata,
  diffMetadata,
  hasAlchemyMetadata,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

const LIST_PAGE_SIZE = 20;
const LIST_MAX_PAGES = 100;
const NAME_MAX_LENGTH = 100;

/** The v2 API rejects calls without an explicit version. */
const atV2ApiVersion = atSpecApiVersion;

/** `snapshot` delivers full objects; `thin` delivers ids you fetch yourself. */
export type EventDestinationPayload = "snapshot" | "thin";

/** An HTTPS (or, in a sandbox, HTTP) URL Stripe POSTs events to. */
export interface EventDestinationWebhookEndpoint {
  url: string;
}

/** The AWS account and region where Stripe creates the EventBridge partner event source. */
export interface EventDestinationAmazonEventbridge {
  awsAccountId: string;
  awsRegion: string;
}

/** The Azure subscription, resource group, and region where Stripe creates the partner topic. */
export interface EventDestinationAzureEventGrid {
  azureSubscriptionId: string;
  azureResourceGroupName: string;
  azureRegion: string;
}

export interface EventDestinationProps {
  /**
   * Label for the destination. If omitted, a unique name is generated from
   * the stack, stage, and logical id.
   */
  name?: string;
  /**
   * Description of what the destination is for.
   */
  description?: string;
  /**
   * Event types delivered to this destination, e.g.
   * `["v1.billing.meter.error_report_triggered"]` for thin events or
   * `["customer.created"]` for snapshot events.
   */
  enabledEvents: string[];
  /**
   * `thin` events carry ids you fetch; `snapshot` events carry the full
   * object. Create-only — changing it replaces the destination.
   * @default "thin"
   */
  eventPayload?: EventDestinationPayload;
  /**
   * Accounts whose events are delivered: `@self` (this account) or
   * `@accounts` (accounts you manage). Create-only — changing it replaces
   * the destination.
   * @default ["@self"]
   */
  eventsFrom?: string[];
  /**
   * API version snapshot events are rendered in. Only for `snapshot`
   * payloads. Create-only — changing it replaces the destination.
   */
  snapshotApiVersion?: string;
  /**
   * Deliver to a webhook URL. Set exactly one of `webhookEndpoint`,
   * `amazonEventbridge`, or `azureEventGrid`; switching between them
   * replaces the destination. The URL updates in place.
   */
  webhookEndpoint?: EventDestinationWebhookEndpoint;
  /**
   * Deliver to an Amazon EventBridge partner event source in this AWS
   * account and region. Create-only — changing it replaces the destination.
   */
  amazonEventbridge?: EventDestinationAmazonEventbridge;
  /**
   * Deliver to an Azure Event Grid partner topic. Create-only — changing it
   * replaces the destination.
   */
  azureEventGrid?: EventDestinationAzureEventGrid;
  /**
   * When true, the destination stops receiving events.
   * @default false
   */
  disabled?: boolean;
  /**
   * User-defined metadata. Alchemy ownership keys (`alchemy_stack` /
   * `alchemy_stage` / `alchemy_id`) are merged in automatically.
   */
  metadata?: Record<string, string>;
}

export type EventDestinationType = "amazon_eventbridge" | "azure_event_grid" | "webhook_endpoint";

export type EventDestination = Resource<
  "Stripe.EventDestination",
  EventDestinationProps,
  {
    /** Stripe event destination id (`ed_…`). */
    id: string;
    /** Label for the destination. */
    name: string;
    /** Description, if set. */
    description: string | undefined;
    /** Where events are delivered. */
    type: EventDestinationType;
    /** Event types delivered to this destination. */
    enabledEvents: string[];
    /** `thin` or `snapshot`. */
    eventPayload: EventDestinationPayload;
    /** Accounts whose events are delivered. */
    eventsFrom: string[];
    /** API version snapshot events are rendered in, if set. */
    snapshotApiVersion: string | undefined;
    /** `enabled` or `disabled`. */
    status: "disabled" | "enabled";
    /** Webhook URL, for a webhook destination. */
    webhookUrl: string | undefined;
    /**
     * Signing secret for verifying webhook deliveries, returned only at
     * creation and preserved in state. Never log this value.
     */
    signingSecret: Redacted.Redacted<string> | undefined;
    /** AWS account and region, for an EventBridge destination. */
    amazonEventbridge: EventDestinationAmazonEventbridge | undefined;
    /** Azure subscription, resource group, and region, for an Event Grid destination. */
    azureEventGrid: EventDestinationAzureEventGrid | undefined;
    /** Azure partner topic name, for an Event Grid destination. */
    azurePartnerTopicName: string | undefined;
    /** EventBridge partner event source ARN, for an EventBridge destination. */
    awsEventSourceArn: string | undefined;
    /** EventBridge partner event source status (`pending` until associated in AWS). */
    awsEventSourceStatus: string | undefined;
    /** User-defined metadata (Alchemy ownership keys stripped). */
    metadata: Record<string, string>;
    /** When the destination was created (ISO 8601). */
    created: string;
    /** Whether the destination exists in live mode. */
    livemode: boolean;
  },
  never,
  Providers,
  EventDestinationLookup
>;

/**
 * Props for {@link EventDestination.lookup}: find an event destination this
 * stack doesn't manage by its id.
 */
export interface EventDestinationLookup {
  /** Stripe event destination id, e.g. `"ed_test_61Vk…"`. */
  id: string;
}

/**
 * A Stripe event destination — where Stripe delivers events: a webhook
 * URL, an Amazon EventBridge partner event source, or an Azure Event Grid
 * partner topic. It is the v2 successor to {@link WebhookEndpoint} and the
 * only way to receive thin events.
 *
 * Name, description, enabled events, the webhook URL, `disabled`, and
 * metadata update in place. The destination type, payload style, event
 * sources, and cloud target are create-only. A webhook destination's
 * signing secret is returned only on create and stored as `Redacted`.
 *
 * @see https://docs.stripe.com/api/v2/core/event_destinations
 *
 * ### Creating a destination
 * **Example:** Thin events to a webhook
 * ```typescript
 * const destination = yield* Stripe.EventDestination("MeterErrors", {
 *   enabledEvents: ["v1.billing.meter.error_report_triggered"],
 *   webhookEndpoint: { url: "https://example.com/stripe/events" },
 * });
 * ```
 *
 * **Example:** Snapshot events to Amazon EventBridge
 * ```typescript
 * const destination = yield* Stripe.EventDestination("Billing", {
 *   eventPayload: "snapshot",
 *   enabledEvents: ["invoice.paid", "customer.subscription.updated"],
 *   amazonEventbridge: { awsAccountId: "123456789012", awsRegion: "us-east-1" },
 * });
 * ```
 *
 * ### Updating a destination
 * **Example:** Pause delivery
 * ```typescript
 * const destination = yield* Stripe.EventDestination("MeterErrors", {
 *   enabledEvents: ["v1.billing.meter.error_report_triggered"],
 *   webhookEndpoint: { url: "https://example.com/stripe/events" },
 *   disabled: true,
 * });
 * ```
 *
 * ### Looking up an existing event destination
 * `EventDestination.lookup` references a destination Alchemy doesn't manage.
 * It is read during plan/deploy, never created, updated or deleted. Stripe
 * returns a signing secret only when it creates a destination, so a
 * looked-up destination has no `signingSecret`.
 *
 * **Example:** Reference an existing event destination
 * ```typescript
 * const ref = Stripe.EventDestination.lookup({ id: "ed_test_61Vk…" });
 * ```
 *
 * @resource
 * @product Webhook
 */
export const EventDestination = Resource<EventDestination>("Stripe.EventDestination");

type EventDestinationAttributes = EventDestination["Attributes"];

const userMetadata = (
  metadata: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalMetadata(tagRecord(metadata));

const redactSecret = (
  secret: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined => {
  if (secret === undefined) return undefined;
  if (typeof secret === "string") return Redacted.make(secret);
  // Distilled and alchemy can resolve different `effect` copies, so a
  // SDK-wrapped Redacted is not readable via alchemy's WeakMap. Unwrap
  // with distilled first, then wrap with ours so state encoding works.
  const unwrapped = unwrapRedactedDeep(secret);
  return typeof unwrapped === "string" ? Redacted.make(unwrapped) : undefined;
};

const typeOf = (news: EventDestinationProps): EventDestinationType =>
  news.amazonEventbridge !== undefined
    ? "amazon_eventbridge"
    : news.azureEventGrid !== undefined
      ? "azure_event_grid"
      : "webhook_endpoint";

const toAttrs = (
  destination: V2CoreEventDestination,
  previousSecret?: Redacted.Redacted<string>,
): EventDestinationAttributes => ({
  id: destination.id,
  name: destination.name,
  description: destination.description || undefined,
  type: destination.type as EventDestinationType,
  enabledEvents: [...destination.enabled_events],
  eventPayload: destination.event_payload as EventDestinationPayload,
  eventsFrom: [...(destination.events_from ?? [])],
  snapshotApiVersion: destination.snapshot_api_version ?? undefined,
  status: destination.status,
  webhookUrl: destination.webhook_endpoint?.url ?? undefined,
  signingSecret: redactSecret(destination.webhook_endpoint?.signing_secret) ?? previousSecret,
  amazonEventbridge:
    destination.amazon_eventbridge === undefined
      ? undefined
      : {
          awsAccountId: destination.amazon_eventbridge.aws_account_id,
          // arn:aws:events:<region>::event-source/aws.partner/stripe.com/…
          awsRegion: destination.amazon_eventbridge.aws_event_source_arn.split(":")[3] ?? "",
        },
  azureEventGrid:
    destination.azure_event_grid === undefined
      ? undefined
      : {
          azureSubscriptionId: destination.azure_event_grid.azure_subscription_id,
          azureResourceGroupName: destination.azure_event_grid.azure_resource_group_name,
          azureRegion: destination.azure_event_grid.azure_region,
        },
  azurePartnerTopicName: destination.azure_event_grid?.azure_partner_topic_name,
  awsEventSourceArn: destination.amazon_eventbridge?.aws_event_source_arn,
  awsEventSourceStatus: destination.amazon_eventbridge?.aws_event_source_status,
  metadata: userMetadata(destination.metadata),
  created: destination.created,
  livemode: destination.livemode,
});

const getById = (id: string) =>
  GetCoreEventDestination({ id, include: ["webhook_endpoint.url"] }).pipe(
    atV2ApiVersion,
    Effect.catchTag("EventDestinationNotFound", () => Effect.undefined),
  );

/** The `page` cursor from a v2 `next_page_url` (`/v2/…?page=page_…&limit=20`). */
const nextPageOf = (url: string | null) => {
  const cursor = url?.match(/[?&]page=([^&]+)/)?.[1];
  return cursor === undefined ? undefined : decodeURIComponent(cursor);
};

const listAllDestinations = Effect.fn(function* () {
  const destinations: V2CoreEventDestination[] = [];
  let page: string | undefined;
  for (let index = 0; index < LIST_MAX_PAGES; index++) {
    const response = yield* GetCoreEventDestinations({
      limit: LIST_PAGE_SIZE,
      include: ["webhook_endpoint.url"],
      ...(page !== undefined ? { page } : {}),
    }).pipe(atV2ApiVersion);
    destinations.push(...response.data);
    page = nextPageOf(response.next_page_url);
    if (page === undefined) break;
  }
  return destinations;
});

const findByAlchemyId = Effect.fn(function* (id: string) {
  const destinations = yield* listAllDestinations();
  for (const destination of destinations) {
    if (yield* hasAlchemyMetadata(id, tagRecord(destination.metadata))) {
      return destination;
    }
  }
  return undefined;
});

const observe = Effect.fn(function* (input: { id?: string; logicalId: string }) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  const found = yield* findByAlchemyId(input.logicalId);
  return found === undefined ? undefined : yield* getById(found.id);
});

const shouldReplace = (
  news: EventDestinationProps,
  output: EventDestinationAttributes | undefined,
): boolean => {
  if (output === undefined) return false;
  if (typeOf(news) !== output.type) return true;
  if ((news.eventPayload ?? "thin") !== output.eventPayload) return true;
  if (news.eventsFrom !== undefined && !arrayEquals(news.eventsFrom, output.eventsFrom)) {
    return true;
  }
  if ((news.snapshotApiVersion ?? undefined) !== output.snapshotApiVersion) return true;
  if (
    news.amazonEventbridge !== undefined &&
    (news.amazonEventbridge.awsAccountId !== output.amazonEventbridge?.awsAccountId ||
      news.amazonEventbridge.awsRegion !== output.amazonEventbridge?.awsRegion)
  ) {
    return true;
  }
  if (
    news.azureEventGrid !== undefined &&
    (news.azureEventGrid.azureSubscriptionId !== output.azureEventGrid?.azureSubscriptionId ||
      news.azureEventGrid.azureResourceGroupName !==
        output.azureEventGrid?.azureResourceGroupName ||
      news.azureEventGrid.azureRegion !== output.azureEventGrid?.azureRegion)
  ) {
    return true;
  }
  return false;
};

export const EventDestinationProvider = () =>
  Provider.succeed(EventDestination, {
    stables: [
      "id",
      "type",
      "eventPayload",
      "eventsFrom",
      "snapshotApiVersion",
      "signingSecret",
      "amazonEventbridge",
      "azureEventGrid",
      "azurePartnerTopicName",
      "awsEventSourceArn",
      "created",
      "livemode",
    ],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (shouldReplace(news, output)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    lookup: Effect.fn(function* ({ id }) {
      const existing = yield* getById(id);
      return existing === undefined ? undefined : toAttrs(existing);
    }),

    read: Effect.fn(function* ({ id, output }) {
      const existing = yield* observe({ id: output?.id, logicalId: id });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, output?.signingSecret);
      return (yield* hasAlchemyMetadata(id, tagRecord(existing.metadata))) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const destinations = yield* listAllDestinations();
      return destinations
        .filter((destination) => {
          const metadata = tagRecord(destination.metadata);
          return metadata[alchemyMetadataKeys.stack] !== undefined;
        })
        .map((destination) => toAttrs(destination));
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const metadata = {
        ...toMetadata(news.metadata),
        ...(yield* createInternalMetadata(id)),
      };
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }));
      const desiredDescription = news.description ?? "";
      const desiredDisabled = news.disabled ?? false;
      const previousSecret = output?.signingSecret;

      let current = yield* observe({ id: output?.id, logicalId: id });
      // A previous generation with a different create-only shape can't be reused.
      if (current !== undefined && shouldReplace(news, toAttrs(current))) {
        current = undefined;
      }

      if (current === undefined) {
        current = yield* CreateCoreEventDestination({
          name,
          type: typeOf(news),
          event_payload: news.eventPayload ?? "thin",
          enabled_events: news.enabledEvents,
          include: ["webhook_endpoint.signing_secret", "webhook_endpoint.url"],
          metadata,
          ...(desiredDescription.length > 0 ? { description: desiredDescription } : {}),
          ...(news.eventsFrom !== undefined ? { events_from: news.eventsFrom } : {}),
          ...(news.snapshotApiVersion !== undefined
            ? { snapshot_api_version: news.snapshotApiVersion }
            : {}),
          ...(news.webhookEndpoint !== undefined
            ? { webhook_endpoint: { url: news.webhookEndpoint.url } }
            : {}),
          ...(news.amazonEventbridge !== undefined
            ? {
                amazon_eventbridge: {
                  aws_account_id: news.amazonEventbridge.awsAccountId,
                  aws_region: news.amazonEventbridge.awsRegion,
                },
              }
            : {}),
          ...(news.azureEventGrid !== undefined
            ? {
                azure_event_grid: {
                  azure_subscription_id: news.azureEventGrid.azureSubscriptionId,
                  azure_resource_group_name: news.azureEventGrid.azureResourceGroupName,
                  azure_region: news.azureEventGrid.azureRegion,
                },
              }
            : {}),
        }).pipe(atV2ApiVersion);
      }
      const secret = redactSecret(current.webhook_endpoint?.signing_secret) ?? previousSecret;

      const { upsert, removed } = diffMetadata(tagRecord(current.metadata), metadata);
      const metadataChanged = upsert.length > 0 || removed.length > 0;
      const nameChanged = current.name !== name;
      const descriptionChanged = (current.description ?? "") !== desiredDescription;
      const eventsChanged = !arrayEquals([...current.enabled_events], news.enabledEvents);
      const urlChanged =
        news.webhookEndpoint !== undefined &&
        current.webhook_endpoint?.url !== news.webhookEndpoint.url;

      if (nameChanged || descriptionChanged || eventsChanged || urlChanged || metadataChanged) {
        current = yield* UpdateCoreEventDestination({
          id: current.id,
          include: ["webhook_endpoint.url"],
          ...(nameChanged ? { name } : {}),
          ...(descriptionChanged ? { description: desiredDescription } : {}),
          ...(eventsChanged ? { enabled_events: news.enabledEvents } : {}),
          ...(urlChanged ? { webhook_endpoint: { url: news.webhookEndpoint!.url } } : {}),
          ...(metadataChanged
            ? {
                metadata: {
                  ...Object.fromEntries(upsert.map((tag) => [tag.Key, tag.Value])),
                  ...Object.fromEntries(removed.map((key) => [key, null])),
                },
              }
            : {}),
        }).pipe(atV2ApiVersion);
      }

      if ((current.status === "disabled") !== desiredDisabled) {
        current = yield* (
          desiredDisabled
            ? CreateCoreEventDestinationDisable({ id: current.id })
            : CreateCoreEventDestinationEnable({ id: current.id })
        ).pipe(atV2ApiVersion);
        current = (yield* getById(current.id)) ?? current;
      }

      return toAttrs(current, secret);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* DeleteCoreEventDestination({ id: output.id }).pipe(
        atV2ApiVersion,
        Effect.catchTag("EventDestinationNotFound", () => Effect.void),
      );
    }),
  });
