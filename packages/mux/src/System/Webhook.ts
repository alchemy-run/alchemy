import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as System from "@distilled.cloud/mux/system";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { redact } from "../internal/redact.ts";
import type { Providers } from "../Providers.ts";

export interface WebhookProps {
  /**
   * HTTPS URL Mux posts events to. Unique among the environment's webhooks.
   */
  address: string;
  /**
   * Set `false` to pause delivery without deleting the webhook.
   * @default true
   */
  enabled?: boolean;
}

export interface WebhookAttributes {
  /** Mux webhook ID. */
  id: string;
  /** URL Mux posts events to. */
  address: string;
  /** Whether Mux is delivering events. */
  enabled: boolean;
  /** ISO 8601 creation time. */
  created_at: string;
  /**
   * Secret for verifying the `mux-signature` header. Mux returns it only when
   * the webhook is created, so it lives in Alchemy state. A webhook found
   * through `lookup` has an empty secret.
   */
  signing_secret: Redacted.Redacted<string>;
}

export interface WebhookLookup {
  /** The webhook's address. */
  address: string;
}

export type Webhook = Resource<
  "Mux.System.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Providers,
  WebhookLookup
>;

/**
 * A Mux webhook: where Mux sends events (asset ready, live stream active,
 * Robots job finished) for the access token's environment. Needs a token with
 * System write.
 *
 * Changing `address` or `enabled` updates the webhook in place, and the
 * signing secret is kept. Mux allows one webhook per address per environment,
 * so a second one for the same address fails with `WebhookAddressInUse`.
 * @see https://www.mux.com/docs/core/listen-for-webhooks
 *
 * ### Creating a Webhook
 * **Example:** Send events to a Worker
 * ```typescript
 * const hook = yield* Mux.System.Webhook("Events", {
 *   address: "https://api.example.com/mux/events",
 * });
 * ```
 *
 * **Example:** Pause delivery without deleting the webhook
 * ```typescript
 * const hook = yield* Mux.System.Webhook("Events", {
 *   address: "https://api.example.com/mux/events",
 *   enabled: false,
 * });
 * ```
 *
 * ### Verifying events
 * Bind the webhook to a runtime with `Mux.System.WebhookVerifier` to check
 * the `mux-signature` header against the request body.
 *
 * ### Referencing an existing webhook
 * **Example:** Find a webhook this stack doesn't manage
 * ```typescript
 * const hook = yield* Mux.System.Webhook.lookup({
 *   address: "https://api.example.com/mux/events",
 * });
 * ```
 *
 * @resource
 */
export const Webhook = Resource<Webhook>("Mux.System.Webhook");

const toAttrs = (
  hook: System.Webhook,
  signing_secret: Redacted.Redacted<string>,
): WebhookAttributes => ({
  id: hook.id,
  address: hook.address,
  enabled: hook.enabled,
  created_at: hook.created_at,
  signing_secret,
});

const NO_SECRET = Redacted.make("");

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      const create = yield* System.createWebhook;
      const update = yield* System.updateWebhook;
      const get = yield* System.getWebhook;
      const del = yield* System.deleteWebhook;
      const list = yield* System.listWebhooks;

      const all = list.items({ limit: 100 }).pipe(Stream.runCollect);

      return {
        stables: ["id", "signing_secret"],
        list: () => all.pipe(Effect.map((hooks) => hooks.map((hook) => toAttrs(hook, NO_SECRET)))),
        lookup: Effect.fn(function* ({ address }) {
          const hooks = yield* all;
          const hook = hooks.find((candidate) => candidate.address === address);
          return hook === undefined ? undefined : toAttrs(hook, NO_SECRET);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const enabled = news.enabled ?? true;
          const observed = output?.id
            ? yield* get({ WEBHOOK_ID: output.id }).pipe(
                Effect.map((res) => res.data),
                Effect.catchTag("NotFound", () => Effect.undefined),
              )
            : undefined;

          if (observed === undefined) {
            // A create that failed with a 5xx may still have happened, so it
            // is retried only on throttling.
            const { data: created } = yield* create({ address: news.address }).pipe(
              MuxRetry.throttling,
            );
            const secret = redact(created.signing_secret);
            if (enabled) return toAttrs(created, secret);
            const { data: paused } = yield* update({ WEBHOOK_ID: created.id, enabled });
            return toAttrs(paused, secret);
          }

          const secret = output?.signing_secret ?? NO_SECRET;
          if (observed.address === news.address && observed.enabled === enabled) {
            return toAttrs(observed, secret);
          }
          const { data: updated } = yield* update({
            WEBHOOK_ID: observed.id,
            address: news.address,
            enabled,
          });
          return toAttrs(updated, secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ WEBHOOK_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* get({ WEBHOOK_ID: output.id }).pipe(
            Effect.map((res) => toAttrs(res.data, output.signing_secret)),
            Effect.catchTag("NotFound", () => Effect.undefined),
          );
        }),
      };
    }),
  );
