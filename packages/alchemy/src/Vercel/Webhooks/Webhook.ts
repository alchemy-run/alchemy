import {
  type CreateWebhookRequestEventsItem,
  createWebhook,
  deleteWebhook,
  getWebhook,
} from "@distilled.cloud/vercel/webhooks";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * An event name a Vercel webhook can subscribe to, e.g.
 * `"deployment.succeeded"` or `"project.created"`.
 */
export type WebhookEvent = CreateWebhookRequestEventsItem;

export interface WebhookProps {
  /**
   * HTTPS endpoint that receives the webhook's POST deliveries. Vercel
   * signs each delivery with the webhook's secret (`x-vercel-signature`).
   *
   * Changing the URL replaces the webhook (Vercel has no update API) — a
   * new webhook (with a new id and secret) is created and the old one is
   * deleted.
   */
  url: string;
  /**
   * Events that trigger a delivery, e.g. `["deployment.succeeded"]`.
   * Order does not matter — the list is compared as a set.
   *
   * Changing the event list replaces the webhook.
   */
  events: (WebhookEvent | (string & {}))[];
  /**
   * Restrict deliveries to specific project IDs. When omitted, the webhook
   * fires for every project in the team.
   *
   * Changing the project list replaces the webhook.
   */
  projectIds?: string[];
}

export type Webhook = Resource<
  "Vercel.Webhook",
  WebhookProps,
  {
    /** The webhook id (`account_hook_…`). Changes on replacement. */
    webhookId: string;
    /** The URL receiving deliveries. */
    url: string;
    /** The subscribed events, as returned by Vercel. */
    events: string[];
    /** Project IDs the webhook is scoped to; `undefined` = all projects. */
    projectIds: string[] | undefined;
    /** The team (or user) the webhook belongs to. */
    ownerId: string;
    /**
     * The secret used to sign deliveries (`x-vercel-signature` is an HMAC
     * SHA-1 of the raw body keyed with this). **Write-only on Vercel's
     * side**: it is returned exactly once by the create call and can never
     * be read back from the API, so Alchemy persists it here in state.
     * A replacement (any prop change) mints a new secret.
     */
    secret: string;
    /** Creation time in epoch milliseconds. */
    createdAt: number;
    /** Last update time in epoch milliseconds. */
    updatedAt: number;
  },
  never,
  Providers
>;

type WebhookAttributes = Webhook["Attributes"];

/**
 * A Vercel account webhook: an HTTPS endpoint that Vercel POSTs platform
 * events to (deployments, domains, projects, …), signed with a
 * create-time secret.
 *
 * Vercel's API has no webhook update operation, so this resource is
 * **replace-only**: changing any prop (`url`, `events`, `projectIds`)
 * creates a new webhook — with a **new id and a new signing secret** —
 * and deletes the old one.
 *
 * @resource
 * @section Creating a Webhook
 * @example Notify an endpoint on successful deployments
 * ```typescript
 * const hook = yield* Vercel.Webhook("Deploys", {
 *   url: "https://ops.example.com/hooks/vercel",
 *   events: ["deployment.succeeded", "deployment.error"],
 * });
 * ```
 *
 * @example Scope a webhook to specific projects
 * ```typescript
 * const hook = yield* Vercel.Webhook("SiteDeploys", {
 *   url: "https://ops.example.com/hooks/site",
 *   events: ["deployment.succeeded"],
 *   projectIds: [project.projectId],
 * });
 * ```
 *
 * @section Verifying deliveries
 * @example Use the write-once signing secret
 * ```typescript
 * // `secret` is returned exactly once by Vercel at create time and is
 * // persisted in the webhook's attributes; deliveries carry an
 * // `x-vercel-signature` header — the HMAC-SHA1 of the raw body keyed
 * // with this secret.
 * const hook = yield* Vercel.Webhook("Deploys", {
 *   url: "https://ops.example.com/hooks/vercel",
 *   events: ["deployment.succeeded"],
 * });
 * return { signingSecret: hook.secret.as<string>() };
 * ```
 *
 * @see https://vercel.com/docs/webhooks
 */
export const Webhook = Resource<Webhook>("Vercel.Webhook");

/** Set-equality for event/project-id lists (order-insensitive). */
const sameMembers = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const as = [...(a ?? [])].sort();
  const bs = [...(b ?? [])].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
};

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  return teamId !== undefined ? { teamId } : {};
});

export const WebhookProvider = () =>
  Provider.succeed(Webhook, {
    stables: ["webhookId", "ownerId", "secret", "createdAt"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // Replace-only: Vercel has no webhook PATCH/update operation, so any
      // difference between the desired props and the last-known state must
      // be converged by create-new-then-delete-old.
      const oldUrl = output?.url ?? olds?.url;
      const oldEvents = output?.events ?? olds?.events;
      const oldProjectIds = output?.projectIds ?? olds?.projectIds;
      if (
        news.url !== oldUrl ||
        !sameMembers(news.events, oldEvents) ||
        !sameMembers(news.projectIds, oldProjectIds)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      // Webhooks carry no name and no metadata to stamp, so identity is the
      // id persisted in state — without it there is nothing to look up
      // (DESIGN §5.4: ownership = state for resources with no env stamp).
      if (!output?.webhookId) return undefined;
      const team = yield* teamScope;
      return yield* getWebhook({ id: output.webhookId, ...team }).pipe(
        Effect.map(
          (hook): WebhookAttributes => ({
            webhookId: hook.id,
            url: hook.url,
            events: [...hook.events],
            projectIds: hook.projectIds ? [...hook.projectIds] : undefined,
            ownerId: hook.ownerId,
            // The secret is write-only on Vercel's side (returned once at
            // create) — carry the persisted value forward.
            secret: output.secret,
            createdAt: hook.createdAt,
            updatedAt: hook.updatedAt,
          }),
        ),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const team = yield* teamScope;
      // Observe — the persisted id is a cache, not proof of existence.
      if (output?.webhookId) {
        const observed = yield* getWebhook({
          id: output.webhookId,
          ...team,
        }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (observed !== undefined) {
          // Existence-only convergence: diff already forces a replacement
          // for any prop change (no update API), so a live webhook is
          // already at desired state — refresh attrs from observation.
          return {
            webhookId: observed.id,
            url: observed.url,
            events: [...observed.events],
            projectIds: observed.projectIds
              ? [...observed.projectIds]
              : undefined,
            ownerId: observed.ownerId,
            secret: output.secret,
            createdAt: observed.createdAt,
            updatedAt: observed.updatedAt,
          } satisfies WebhookAttributes;
        }
      }
      // Ensure — missing (greenfield, or deleted out-of-band) → create.
      const created = yield* createWebhook({
        url: news.url,
        events: news.events,
        ...(news.projectIds ? { projectIds: news.projectIds } : {}),
        ...team,
      });
      return {
        webhookId: created.id,
        url: created.url,
        events: [...created.events],
        projectIds: created.projectIds ? [...created.projectIds] : undefined,
        ownerId: created.ownerId,
        // Returned exactly once — persist it now or lose it forever.
        secret: Redacted.isRedacted(created.secret)
          ? Redacted.value(created.secret)
          : created.secret,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
      } satisfies WebhookAttributes;
    }),
    delete: Effect.fn(function* ({ output }) {
      const team = yield* teamScope;
      yield* deleteWebhook({ id: output.webhookId, ...team }).pipe(
        // Already gone (out-of-band delete, or a re-run after a state
        // persistence failure) is success, not an error.
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }),
  });
