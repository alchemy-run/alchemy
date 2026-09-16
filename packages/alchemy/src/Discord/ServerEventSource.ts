import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  eventKey,
  type GatewayDispatch,
  Mentioned,
  MessageCreated,
  parseGatewayEvent,
  type ServerEvent,
} from "./Events.ts";

/** The event terms a subscription can select. */
export type ServerEventClass = typeof Mentioned | typeof MessageCreated;

/**
 * Subscription options for {@link consumeServerEvents}. Scope defaults
 * to EVERY server the bot is a member of — a bot is invited to the
 * servers it serves, so membership usually IS the configuration.
 * (Discord's API calls servers "guilds"; this surface says server.)
 */
export interface ServerEventSourceOptions<
  E extends readonly ServerEventClass[] = readonly ServerEventClass[],
> {
  /**
   * Restrict delivery to one server. Omitted: every server the bot
   * is in.
   */
  readonly serverId?: string;
  /**
   * The typed EVENT TERMS to deliver (`[Discord.Mentioned]`) — the
   * handler's parameter type is exactly the union of their payloads,
   * so selecting one event needs no `Match` at all.
   * @default every server event
   */
  readonly events?: E;
}

/**
 * Subscribe to events from the servers a Discord bot is a member of —
 * deliveries arrive ALREADY PARSED and PRE-SELECTED: `events` names
 * the typed event terms to deliver, and the handler receives exactly
 * that union, never raw gateway payloads.
 *
 * Call it in the init phase of a host; the handler runs once per
 * delivery. Wiring the transport is the providing Layer's job —
 * {@link ServerEventSourcePolling} synthesizes deliveries from the
 * REST API locally; {@link ServerEventSourceGateway} runs the real
 * websocket; an interactions-webhook Layer can provide the same tag
 * with the same semantics.
 * @example
 * ```typescript
 * // one event selected — the handler IS the route, no Match needed
 * yield* Discord.consumeServerEvents({ events: [Discord.Mentioned] }, (mention) =>
 *   frontDesk.send(mention, { key: Discord.eventKey(mention) }),
 * );
 * ```
 */
export function consumeServerEvents<
  const E extends readonly ServerEventClass[] = readonly ServerEventClass[],
  Req = never,
>(
  options: ServerEventSourceOptions<E>,
  process: (event: InstanceType<E[number]>) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, ServerEventSource> {
  return Effect.gen(function* () {
    const source = yield* ServerEventSource;
    const selected = options.events;
    yield* source(
      options.serverId !== undefined ? { serverId: options.serverId } : {},
      (delivery) =>
        Option.match(parseGatewayEvent(delivery), {
          onNone: () => Effect.void,
          onSome: (event) =>
            selected !== undefined &&
            !selected.some((term) => term["~alchemy/Name"] === event._tag)
              ? Effect.void // unselected events never reach the handler
              : process(event as InstanceType<E[number]>),
        }),
    );
  });
}

export type ServerEventSourceService = <Req = never>(
  options: { readonly serverId?: string },
  process: (event: GatewayDispatch) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class ServerEventSource extends Context.Service<
  ServerEventSource,
  ServerEventSourceService
>()("Discord.ServerEventSource") {}

export { eventKey };
export type { ServerEvent };
