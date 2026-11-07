import { sanitizeKey } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { WebhookEvent } from "./Webhook.ts";

/** A sandbox lifecycle event, as Boat delivers it to a webhook. */
export interface SandboxEvent {
  /** The event's id. A redelivered event keeps it: deduplicate on it. */
  readonly id: string;
  readonly type: WebhookEvent;
  readonly createdAt: string;
  readonly data: {
    readonly sandbox: {
      readonly id: string;
      readonly name?: string;
      /**
       * The sandbox's labels, read from Boat when the event is scoped to the
       * stack. `undefined` with `scope: "account"`.
       */
      readonly labels?: Readonly<Record<string, string>>;
    };
    /** On `sandbox.ready`, `sandbox.error` and `sandbox.archived`. */
    readonly previousState?: string;
    /** The state the sandbox is in now. */
    readonly state?: string;
    /** On `sandbox.degraded` and `sandbox.recovered`: why. */
    readonly reason?: string;
  };
  /** Which delivery attempt this is, from 1. */
  readonly attempt: number;
}

export interface SandboxEventsProps {
  /**
   * The events to receive.
   * @default every sandbox lifecycle event
   */
  readonly events?: ReadonlyArray<WebhookEvent>;
  /**
   * Whose sandboxes. Boat sends a webhook every event in the account.
   * `"stack"` hands the handler only the sandboxes this stack and stage own
   * (declared, or created by its bindings), and adds each sandbox's labels
   * to the event; `"account"` hands it everything.
   * @default "stack"
   */
  readonly scope?: "stack" | "account";
  /**
   * The path on the host Boat delivers to.
   * @default "/__alchemy/boat/events"
   */
  readonly path?: string;
}

/** Receives sandbox lifecycle events on a host. */
export type SandboxEventsService = <Req = never>(
  props: SandboxEventsProps,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Receive Boat sandbox lifecycle events (`sandbox.ready`,
 * `sandbox.hydrated`, `sandbox.error`, `sandbox.archived`,
 * `sandbox.degraded`, `sandbox.recovered`) in a Cloudflare Worker or any
 * other webhook host.
 *
 * At deploy, a {@link Webhook} is created pointing at the host, and its
 * signing secret is given to the host as a secret (a Cloudflare secret on
 * a Worker). While the host runs,
 * each delivery's `X-Ascii-Signature` (HMAC-SHA256 over the delivery id,
 * timestamp and raw body) is checked before the handler runs; an unsigned,
 * wrongly signed, altered or stale (over five minutes old) request is
 * refused with 401, and bodies over 1 MB are refused unread. Boat retries a
 * failed delivery, so handlers should be idempotent on `event.id`.
 *
 * Boat sends a webhook the events of every sandbox in the account, and an
 * account has at most 10 webhooks. With the default `scope: "stack"`, the
 * host looks each sandbox up with a key of its own, created at deploy and
 * deleted with the host, that can only read sandboxes (`sandbox.read`), and drops
 * events for sandboxes other stacks or stages own, and for sandboxes
 * already deleted. The scope is a filter, not an access boundary: anyone
 * in the account who can create sandboxes can label one with the stack's
 * labels.
 *
 * ### Handling lifecycle events
 * **Example:** Record when a sandbox stops
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Boat.consumeSandboxEvents({ events: ["sandbox.archived"] }, (event) =>
 *       Effect.log(`sandbox ${event.data.sandbox.id} stopped`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(Boat.SandboxEventsLive)),
 * ) {}
 * ```
 *
 * **Example:** Every sandbox in the account
 * ```typescript
 * yield* Boat.consumeSandboxEvents({ scope: "account", events: ["sandbox.error"] }, (event) =>
 *   Effect.logError(`sandbox ${event.data.sandbox.id} failed`),
 * );
 * ```
 *
 * @binding
 * @product Webhook
 */
export class SandboxEvents extends Context.Service<SandboxEvents, SandboxEventsService>()(
  "Boat.SandboxEvents",
) {}

/** Subscribes the current host to sandbox lifecycle events. */
export const consumeSandboxEvents = <Req = never>(
  props: SandboxEventsProps,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
) => SandboxEvents.use((source) => source(props, process));

/** Where Boat delivers on the host. */
export const sandboxEventsPath = (props: SandboxEventsProps): string =>
  props.path ?? "/__alchemy/boat/events";

/** The env var the signing secret is given to the host under. */
export const sandboxEventsSecretEnvName = (path: string): string =>
  `ALCHEMY_BOAT_WEBHOOK_SECRET_${sanitizeKey(path)}`;
