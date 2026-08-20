import {
  DeleteWebhookEndpointsWebhookEndpoint,
  GetWebhookEndpoints,
  GetWebhookEndpointsWebhookEndpoint,
  PostWebhookEndpoints,
  PostWebhookEndpointsWebhookEndpoint,
  type PostWebhookEndpointsWebhookEndpointRequest,
  type WebhookEndpoint as StripeWebhookEndpointObject,
} from "@distilled.cloud/stripe/stripe";
import type { StripeOpError } from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { arrayEqualsUnordered } from "../Util/equal.ts";
import {
  brandMetadata,
  isOwned,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
  type Metadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/** Stripe caps `limit` at 100 for every list endpoint. */
const PAGE_SIZE = 100;

/**
 * Hard ceiling on list pagination. A Stripe account may not have more than
 * a handful of webhook endpoints (Stripe's own limit is 16 per account in
 * the dashboard), so 20 pages is an unreachable bound that still guarantees
 * the loop terminates.
 */
const MAX_PAGES = 20;

export type WebhookEndpointProps = {
  /**
   * HTTPS URL Stripe delivers events to. Mutable — changing it updates the
   * existing endpoint in place and preserves the signing secret.
   */
  url: string;
  /**
   * Event types to deliver to this endpoint, e.g.
   * `["invoice.paid", "customer.subscription.deleted"]`. Pass `["*"]` to
   * enable every event except those requiring explicit selection.
   *
   * Compared as a **set** — Stripe does not preserve the order you send,
   * so reordering this array never produces an API call.
   */
  enabledEvents: string[];
  /**
   * Free-form description of what the endpoint is for. Mutable. Clearing it
   * (omitting the prop after having set it) unsets the description on
   * Stripe.
   */
  description?: string;
  /**
   * Whether the endpoint receives events from **connected accounts**
   * (`true`) instead of this account (`false`).
   *
   * Stripe fixes this at creation and never returns it on the object, so
   * Alchemy tracks the value it last created with. Changing it **replaces**
   * the endpoint, which mints a new signing secret.
   *
   * @default false
   */
  connect?: boolean;
  /**
   * Pin the Stripe API version events are rendered with, e.g.
   * `"2024-06-20"`. Defaults to the account's default API version.
   *
   * Immutable — changing an explicitly-pinned version **replaces** the
   * endpoint, which mints a new signing secret.
   */
  apiVersion?: string;
  /**
   * Pause delivery without deleting the endpoint. Mutable — maps to the
   * object's `status` (`"enabled"` / `"disabled"`).
   *
   * @default false
   */
  disabled?: boolean;
  /**
   * Arbitrary key/value metadata attached to the endpoint. Alchemy adds its
   * own `alchemy_stack` / `alchemy_stage` / `alchemy_id` keys alongside
   * these to brand the object as stack-owned; those keys are stripped from
   * the `metadata` attribute so they never show up as drift.
   */
  metadata?: Record<string, string>;
};

export type WebhookEndpointAttributes = {
  /** Stripe object ID, e.g. `we_1P...`. */
  webhookEndpointId: string;
  /** URL Stripe delivers events to. */
  url: string;
  /**
   * Event types enabled on the endpoint, in whatever order Stripe returned
   * them — compare as a set, not an array.
   */
  enabledEvents: string[];
  /** Description of the endpoint, or `undefined` when unset. */
  description: string | undefined;
  /** Delivery status: `"enabled"` or `"disabled"`. */
  status: "enabled" | "disabled" | (string & {});
  /**
   * Stripe API version events are rendered with. Always concrete — Stripe
   * fills in the account default when `apiVersion` was not pinned.
   */
  apiVersion: string | undefined;
  /** ID of the Connect application that owns the endpoint, if any. */
  application: string | undefined;
  /**
   * Whether the endpoint listens to connected-account events. Stripe never
   * returns this on the object, so it reflects the value Alchemy created
   * the endpoint with; `undefined` on an endpoint recovered from Stripe
   * rather than from state.
   */
  connect: boolean | undefined;
  /** `true` when the endpoint lives in live mode rather than test mode. */
  livemode: boolean;
  /** Unix timestamp (seconds) the endpoint was created at. */
  created: number;
  /**
   * The endpoint's signing secret (`whsec_...`), used to verify the
   * `Stripe-Signature` header.
   *
   * Stripe returns it **only in the create response** — every subsequent
   * `GET` omits it — so persisted state is the authoritative copy and is
   * carried forward across updates and reads. It is `undefined` for an
   * endpoint discovered by list (adoption or a lost state row); recovering
   * the secret then requires rolling it in the Stripe dashboard.
   */
  secret: Redacted.Redacted<string> | undefined;
  /** User metadata, with Alchemy's internal `alchemy_*` keys stripped. */
  metadata: Record<string, string>;
};

export type WebhookEndpoint = Resource<
  "Stripe.WebhookEndpoint",
  WebhookEndpointProps,
  WebhookEndpointAttributes,
  never,
  Providers
>;

/**
 * A Stripe webhook endpoint: the registration that tells Stripe which
 * events to POST to your server, and the source of the signing secret your
 * handler verifies them with.
 *
 * Creating the endpoint returns a `secret` (`whsec_...`) exactly once.
 * Alchemy persists it as a `Redacted` attribute and carries it forward on
 * every subsequent read and update, so it stays available to bind into a
 * Worker or Lambda for the lifetime of the resource. Replacing the endpoint
 * (changing `connect` or a pinned `apiVersion`) mints a **new** secret.
 *
 * ### Creating a Webhook Endpoint
 * **Example:** Minimal endpoint
 * ```typescript
 * const endpoint = yield* Stripe.WebhookEndpoint("PaymentEvents", {
 *   url: "https://api.example.com/stripe/webhook",
 *   enabledEvents: ["checkout.session.completed"],
 * });
 * ```
 *
 * **Example:** Fully configured endpoint
 * ```typescript
 * const endpoint = yield* Stripe.WebhookEndpoint("BillingEvents", {
 *   url: "https://api.example.com/stripe/billing",
 *   enabledEvents: [
 *     "invoice.paid",
 *     "invoice.payment_failed",
 *     "customer.subscription.deleted",
 *   ],
 *   description: "Billing lifecycle events for the subscriptions service",
 *   apiVersion: "2024-06-20",
 *   connect: false,
 *   metadata: { team: "billing" },
 * });
 * ```
 *
 * **Example:** Pause delivery without deleting the endpoint
 * ```typescript
 * const endpoint = yield* Stripe.WebhookEndpoint("BillingEvents", {
 *   url: "https://api.example.com/stripe/billing",
 *   enabledEvents: ["invoice.paid"],
 *   disabled: true,
 * });
 * ```
 *
 * ### Verifying signatures
 * **Example:** Bind the signing secret into a Worker
 * ```typescript
 * const endpoint = yield* Stripe.WebhookEndpoint("StripeEvents", {
 *   url: "https://api.example.com/stripe/webhook",
 *   enabledEvents: ["checkout.session.completed"],
 * });
 *
 * const api = yield* Api({
 *   env: { STRIPE_WEBHOOK_SECRET: endpoint.secret },
 * });
 * ```
 *
 * **Example:** Verify the delivered payload in the handler
 * ```typescript
 * import { Webhooks } from "@distilled.cloud/stripe";
 *
 * const handle = Effect.gen(function* () {
 *   const request = yield* HttpServerRequest;
 *   const payload = yield* request.text;
 *   const event = yield* Webhooks.constructEvent({
 *     payload,
 *     signature: request.headers["stripe-signature"],
 *     secret: env.STRIPE_WEBHOOK_SECRET,
 *   });
 *   yield* Effect.log(`received ${event.type}`);
 *   return HttpServerResponse.text("ok");
 * });
 * ```
 *
 * ### Reacting to another Stripe resource
 * **Example:** Listen for events on a specific product's prices
 * ```typescript
 * const product = yield* Stripe.Product("ProApi", { name: "Pro API" });
 *
 * const endpoint = yield* Stripe.WebhookEndpoint("PriceEvents", {
 *   url: "https://api.example.com/stripe/prices",
 *   enabledEvents: ["price.created", "price.updated", "price.deleted"],
 *   metadata: { productId: product.productId },
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/webhook_endpoints
 *
 * @resource
 */
export const WebhookEndpoint = Resource<WebhookEndpoint>(
  "Stripe.WebhookEndpoint",
);

const WEBHOOK_ENDPOINT_STABLES = [
  "webhookEndpointId",
  "secret",
  "connect",
  "apiVersion",
  "livemode",
  "created",
] satisfies Extract<keyof WebhookEndpointAttributes, string>[];

export const WebhookEndpointProvider = () =>
  Provider.succeed(WebhookEndpoint, {
    stables: WEBHOOK_ENDPOINT_STABLES,
    list: Effect.fn(function* () {
      const endpoints = yield* listAllWebhookEndpoints;
      return endpoints.map((endpoint) => toAttributes(endpoint, {}));
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!news || !isResolved(news)) return undefined;
      if (!output) return undefined;
      // `connect` is fixed at creation and never returned by Stripe, so it
      // can only be compared against the value we created with. An adopted
      // endpoint has no recorded value — leave it alone rather than
      // replacing a live endpoint on a guess.
      if (
        output.connect !== undefined &&
        (news.connect ?? false) !== output.connect
      ) {
        return { action: "replace" } as const;
      }
      // Stripe fills `api_version` in with the account default when the
      // caller does not pin one, so an omitted `apiVersion` can never be
      // distinguished from "pinned to today's default" — only an explicit
      // change replaces.
      if (
        news.apiVersion !== undefined &&
        output.apiVersion !== undefined &&
        news.apiVersion !== output.apiVersion
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.webhookEndpointId) {
        return yield* GetWebhookEndpointsWebhookEndpoint({
          webhook_endpoint: output.webhookEndpointId,
        }).pipe(
          Effect.map((endpoint) =>
            toAttributes(endpoint, {
              connect: output.connect,
              secret: output.secret,
            }),
          ),
          Effect.catchIf(isMissing, () => Effect.succeed(undefined)),
        );
      }
      // State loss / adoption: Stripe has no tags, so re-discovery works off
      // the `alchemy_*` metadata branding. Falling back to the URL (the
      // endpoint's natural key) finds a hand-made endpoint, which is
      // reported as Unowned so the engine gates takeover behind `--adopt`.
      const endpoints = yield* listAllWebhookEndpoints;
      for (const endpoint of endpoints) {
        if (yield* isOwned(id, toMetadata(endpoint.metadata))) {
          return toAttributes(endpoint, {});
        }
      }
      const url = olds?.url;
      if (url === undefined) return undefined;
      const foreign = endpoints.find((endpoint) => endpoint.url === url);
      return foreign ? Unowned(toAttributes(foreign, {})) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` caches the id but is never proof the endpoint
      //    still exists, so a missing object falls through to create.
      let observed = output?.webhookEndpointId
        ? yield* GetWebhookEndpointsWebhookEndpoint({
            webhook_endpoint: output.webhookEndpointId,
          }).pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)))
        : undefined;

      // 2. Ensure — create when missing. The signing secret is only ever
      //    present on this response.
      let createdSecret: Redacted.Redacted<string> | undefined;
      if (observed === undefined) {
        const created = yield* PostWebhookEndpoints({
          url: news.url,
          enabled_events: [...news.enabledEvents],
          metadata: desiredMetadata,
          ...(news.description !== undefined
            ? { description: news.description }
            : {}),
          ...(news.apiVersion !== undefined
            ? { api_version: news.apiVersion }
            : {}),
          ...(news.connect !== undefined ? { connect: news.connect } : {}),
        });
        createdSecret = toRedacted(created.secret);
        observed = created;
      }

      // 3. Sync — diff every mutable aspect against the OBSERVED object and
      //    apply one delta call, or none at all. A fresh create only reaches
      //    the API again when `disabled: true` was requested (Stripe has no
      //    create-time `disabled` parameter).
      const update: PostWebhookEndpointsWebhookEndpointRequest = {
        webhook_endpoint: observed.id,
      };
      let changed = false;
      if (observed.url !== news.url) {
        update.url = news.url;
        changed = true;
      }
      if (!arrayEqualsUnordered(observed.enabled_events, news.enabledEvents)) {
        update.enabled_events = [...news.enabledEvents];
        changed = true;
      }
      const desiredDescription = news.description ?? "";
      if ((observed.description ?? "") !== desiredDescription) {
        // Stripe unsets a description when an empty string is posted.
        update.description = desiredDescription;
        changed = true;
      }
      const desiredDisabled = news.disabled ?? false;
      if ((observed.status === "disabled") !== desiredDisabled) {
        update.disabled = desiredDisabled;
        changed = true;
      }
      const observedMetadata = toMetadata(observed.metadata);
      if (!metadataEqual(observedMetadata, desiredMetadata)) {
        update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
        changed = true;
      }
      const final = changed
        ? yield* PostWebhookEndpointsWebhookEndpoint(update)
        : observed;

      // 4. Return — the secret comes from this run's create, an earlier
      //    create persisted in state, or nowhere at all (adopted endpoint).
      return toAttributes(final, {
        connect: news.connect ?? output?.connect ?? false,
        secret: createdSecret ?? toRedacted(final.secret) ?? output?.secret,
      });
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* DeleteWebhookEndpointsWebhookEndpoint({
        webhook_endpoint: output.webhookEndpointId,
      }).pipe(Effect.catchIf(isMissing, () => Effect.void));
    }),
  });

/**
 * Stripe reports a deleted or never-existing object as HTTP 404 with
 * `type: "invalid_request_error"` and `code: "resource_missing"`. distilled
 * dispatches on the error `type` before the status code, so the failure
 * surfaces as `InvalidRequestError` rather than `NotFound` — both shapes are
 * treated as "absent" here.
 */
const isMissing = (e: StripeOpError): boolean =>
  e._tag === "NotFound" ||
  (e._tag === "InvalidRequestError" && e.code === "resource_missing");

/** Normalise distilled's `string | Redacted` sensitive value to `Redacted`. */
const toRedacted = (
  value: string | Redacted.Redacted<string> | undefined,
): Redacted.Redacted<string> | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? value
      : Redacted.make(value);

/** Drop `undefined` values from Stripe's loosely-typed metadata map. */
const toMetadata = (
  metadata: { [key: string]: string | undefined } | null | undefined,
): Metadata => {
  const out: Metadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const toAttributes = (
  endpoint: StripeWebhookEndpointObject,
  carry: {
    connect?: boolean | undefined;
    secret?: Redacted.Redacted<string> | undefined;
  },
): WebhookEndpointAttributes => ({
  webhookEndpointId: endpoint.id,
  url: endpoint.url,
  enabledEvents: [...endpoint.enabled_events],
  description: endpoint.description ?? undefined,
  status: endpoint.status,
  apiVersion: endpoint.api_version ?? undefined,
  application: endpoint.application ?? undefined,
  connect: carry.connect,
  livemode: endpoint.livemode,
  created: endpoint.created,
  secret: carry.secret ?? toRedacted(endpoint.secret),
  metadata: stripInternalMetadata(toMetadata(endpoint.metadata)),
});

/**
 * Exhaustively enumerate the account's webhook endpoints using Stripe's
 * `starting_after` cursor. Bounded by {@link MAX_PAGES} so a misbehaving
 * `has_more` can never spin forever.
 */
const listAllWebhookEndpoints = Effect.gen(function* () {
  const all: StripeWebhookEndpointObject[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetWebhookEndpoints({
      limit: PAGE_SIZE,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    all.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return all;
});
