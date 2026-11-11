import * as webhooks from "@distilled.cloud/e2b/webhooks";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { E2BUnexpectedResponse } from "./Errors.ts";
import { e2bName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/** Sandbox lifecycle events E2B delivers to webhooks. */
export type SandboxEventType =
  | "sandbox.lifecycle.created"
  | "sandbox.lifecycle.killed"
  | "sandbox.lifecycle.updated"
  | "sandbox.lifecycle.paused"
  | "sandbox.lifecycle.resumed"
  | "sandbox.lifecycle.checkpointed";

export const ALL_SANDBOX_EVENTS: ReadonlyArray<SandboxEventType> = [
  "sandbox.lifecycle.created",
  "sandbox.lifecycle.killed",
  "sandbox.lifecycle.updated",
  "sandbox.lifecycle.paused",
  "sandbox.lifecycle.resumed",
  "sandbox.lifecycle.checkpointed",
];

export interface WebhookProps {
  /**
   * Webhook name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Updated in place.
   */
  name?: string;
  /** The URL E2B POSTs each event to. */
  url: string;
  /**
   * The events to deliver.
   * @default every sandbox lifecycle event
   */
  events?: SandboxEventType[];
  /**
   * Whether E2B delivers events.
   * @default true
   */
  enabled?: boolean;
  /**
   * The secret E2B signs each delivery with. The `e2b-signature` header is
   * the unpadded base64 SHA-256 of this secret followed by the raw body.
   * At least 32 characters.
   */
  signatureSecret: Redacted.Redacted<string>;
}

export interface WebhookAttributes {
  /** E2B's webhook id. */
  webhookId: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
}

export interface Webhook extends Resource<
  "E2B.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * An E2B webhook: E2B POSTs every sandbox lifecycle event (created, paused,
 * resumed, checkpointed, updated, killed) in your team to a URL.
 *
 * Use `E2B.SandboxEvents` to point a webhook at a Worker or Function and
 * handle the events there; it declares this resource for you and verifies
 * each delivery's signature. Declare a `Webhook` directly for an endpoint
 * Alchemy does not deploy.
 *
 * E2B webhooks carry no labels, so Alchemy recognises its webhooks by their
 * generated name.
 *
 * ### Creating a Webhook
 * **Example:** Deliver pause and kill events to an existing endpoint
 * ```typescript
 * export const Lifecycle = E2B.Webhook("Lifecycle", {
 *   url: "https://hooks.example.com/e2b",
 *   events: ["sandbox.lifecycle.paused", "sandbox.lifecycle.killed"],
 *   signatureSecret: Config.Redacted("E2B_WEBHOOK_SECRET"),
 * });
 * ```
 *
 * ### Referencing a webhook the stack doesn't manage
 * `E2B.Webhook.lookup` finds an existing webhook by name. Nothing is created,
 * adopted or deleted.
 *
 * **Example:** Look one up by name
 * ```typescript
 * const audit = E2B.Webhook.lookup({ name: "audit" });
 * const deliveries = yield* E2B.ReadWebhook(audit);
 * ```
 *
 * @resource
 * @product Webhook
 */
export const Webhook = Resource<Webhook>("E2B.Webhook");

const toAttrs = (
  webhook: webhooks.WebhookDetail | webhooks.WebhookCreation,
): WebhookAttributes => ({
  webhookId: webhook.id,
  name: webhook.name,
  url: webhook.url,
  events: [...webhook.events],
  enabled: webhook.enabled,
});

const findByName = (name: string) =>
  webhooks.listWebhooks({}).pipe(Effect.map((all) => all.find((hook) => hook.name === name)));

const observe = (webhookId: string | undefined, name: string) =>
  webhookId !== undefined
    ? webhooks.getWebhook({ webhookID: webhookId }).pipe(
        Effect.map((hook): webhooks.WebhookDetail | undefined => hook),
        Effect.catchTag("NotFound", () => findByName(name)),
      )
    : findByName(name);

const sameEvents = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      return {
        stables: ["webhookId"],
        lookup: Effect.fn(function* ({ name }) {
          const hook = yield* observe(undefined, name);
          return hook === undefined ? undefined : toAttrs(hook);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          const hook = yield* observe(output?.webhookId, name);
          if (hook === undefined) return undefined;
          const attrs = toAttrs(hook);
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          // Webhooks are renamed in place, so the desired name wins over the
          // stored one; the stored id finds the webhook either way.
          const name = news.name ?? output?.name ?? (yield* e2bName(id, undefined));
          const events = [...(news.events ?? ALL_SANDBOX_EVENTS)];
          const enabled = news.enabled ?? true;

          // Observe
          const observed = yield* observe(output?.webhookId, output?.name ?? name);

          // Ensure
          if (observed === undefined) {
            yield* session.note(`Creating webhook ${name}...`);
            const created = yield* webhooks.createWebhook({
              name,
              url: news.url,
              events,
              enabled,
              signatureSecret: news.signatureSecret,
            });
            return toAttrs(created);
          }

          // Sync — the signing secret is write-only, so `olds` is the only
          // signal that the stored one already matches.
          const secretChanged =
            olds === undefined ||
            Redacted.value(olds.signatureSecret) !== Redacted.value(news.signatureSecret);
          if (
            observed.name !== name ||
            observed.url !== news.url ||
            observed.enabled !== enabled ||
            !sameEvents(observed.events, events) ||
            secretChanged
          ) {
            yield* webhooks.updateWebhook({
              webhookID: observed.id,
              name,
              url: news.url,
              events,
              enabled,
              ...(secretChanged ? { signatureSecret: news.signatureSecret } : {}),
            });
            const updated = yield* observe(observed.id, name);
            if (updated === undefined) {
              return yield* new E2BUnexpectedResponse({
                message: `E2B webhook ${name} vanished after update`,
              });
            }
            return toAttrs(updated);
          }
          return toAttrs(observed);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* webhooks
            .deleteWebhook({ webhookID: output.webhookId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const all = yield* webhooks.listWebhooks({});
          return all.filter((hook) => isGeneratedName(hook.name)).map(toAttrs);
        }),
      };
    }),
  );
