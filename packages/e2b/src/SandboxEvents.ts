import { sanitizeKey } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { SandboxEventType } from "./Webhook.ts";

/** A sandbox lifecycle event, as E2B delivers it to a webhook. */
export interface SandboxEvent {
  /** The event's id. A redelivered event keeps it: deduplicate on it. */
  readonly id: string;
  readonly version: string;
  readonly type: SandboxEventType;
  readonly timestamp: string;
  readonly sandbox_id: string;
  readonly sandbox_execution_id: string;
  readonly sandbox_template_id: string;
  readonly sandbox_build_id: string;
  readonly sandbox_team_id: string;
  readonly event_data?: {
    /** The sandbox's metadata, including the ownership stamp of the host that created it. */
    readonly sandbox_metadata?: Readonly<Record<string, string>>;
    /** On `killed` and `paused`: what the run used. */
    readonly execution?: Readonly<Record<string, unknown>>;
    /** On `killed`. */
    readonly kill_reason?: string;
    /** On `paused`: `full` (memory and disk) or `filesystem`. */
    readonly pause_mode?: "full" | "filesystem";
    /** On `resumed`: `restore` (memory) or `reboot`. */
    readonly resume_mode?: "restore" | "reboot";
  };
}

export interface SandboxEventsProps {
  /**
   * The events to receive.
   * @default every sandbox lifecycle event
   */
  readonly events?: ReadonlyArray<SandboxEventType>;
  /**
   * The secret E2B signs deliveries with. A random one is generated and
   * bound onto the host when omitted.
   */
  readonly secret?: Redacted.Redacted<string>;
  /**
   * The path on the host E2B delivers to.
   * @default "/__alchemy/e2b/events"
   */
  readonly path?: string;
}

/** Receives sandbox lifecycle events on a host. */
export type SandboxEventsService = <Req = never>(
  props: SandboxEventsProps,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Receive E2B sandbox lifecycle events (created, paused, resumed,
 * checkpointed, updated, killed) in a Worker or any other webhook host.
 *
 * At deploy, an {@link Webhook} is created pointing at the host. At runtime,
 * each delivery's `e2b-signature` is verified before the handler runs; an
 * unsigned or wrongly signed request is rejected with 401. E2B retries a
 * failed delivery up to three times, so handlers should be idempotent on
 * `event.id`.
 *
 * ### Handling lifecycle events
 * **Example:** Record every killed sandbox
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* E2B.consumeSandboxEvents({ events: ["sandbox.lifecycle.killed"] }, (event) =>
 *       Effect.log(`sandbox ${event.sandbox_id} killed: ${event.event_data?.kill_reason}`),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(Effect.provide(E2B.SandboxEventsLive)),
 * ) {}
 * ```
 *
 * @binding
 * @product Webhook
 */
export class SandboxEvents extends Context.Service<SandboxEvents, SandboxEventsService>()(
  "E2B.SandboxEvents",
) {}

/** Subscribes the current host to sandbox lifecycle events. */
export const consumeSandboxEvents = <Req = never>(
  props: SandboxEventsProps,
  process: (event: SandboxEvent) => Effect.Effect<void, never, Req>,
) => SandboxEvents.use((source) => source(props, process));

/** Where E2B delivers on the host. */
export const sandboxEventsPath = (props: SandboxEventsProps): string =>
  props.path ?? "/__alchemy/e2b/events";

/** The env var the signing secret is bound under. */
export const sandboxEventsSecretEnvName = (path: string): string =>
  `ALCHEMY_E2B_WEBHOOK_SECRET_${sanitizeKey(path)}`;
