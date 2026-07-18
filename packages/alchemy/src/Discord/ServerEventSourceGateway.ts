import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Socket from "effect/unstable/socket/Socket";
import { DiscordCredentials } from "./Credentials.ts";
import type { GatewayDispatch, GatewayMessage } from "./Events.ts";
import {
  ServerEventSource,
  type ServerEventSourceService,
} from "./ServerEventSource.ts";

/**
 * Gateway intents — which event families Discord pushes over the
 * socket. The default asks for exactly what the typed wire delivers:
 * server messages (+ their content) and DMs.
 *
 * @see {@link https://discord.com/developers/docs/events/gateway#gateway-intents | Gateway intents}
 */
export const DEFAULT_INTENTS =
  (1 << 0) | // GUILDS
  (1 << 9) | // GUILD_MESSAGES
  (1 << 12) | // DIRECT_MESSAGES
  (1 << 15); // MESSAGE_CONTENT

export interface ServerEventSourceGatewayOptions {
  /**
   * Gateway intents bitfield.
   *
   * NOTE: `MESSAGE_CONTENT` is a PRIVILEGED intent — enable it for the
   * bot under Discord Developer Portal → Bot → Privileged Gateway
   * Intents, or `content` arrives empty on every message.
   * @default {@link DEFAULT_INTENTS}
   */
  readonly intents?: number;
}

/** One Discord gateway frame (the fields this client reads). */
interface GatewayFrame {
  readonly op: number;
  readonly s?: number | null;
  readonly t?: string | null;
  readonly d?: unknown;
}

const GATEWAY_FALLBACK = "wss://gateway.discord.gg";

/**
 * A REAL-TIME, websocket implementation of {@link ServerEventSource} —
 * the Discord Gateway. Same tag as {@link ServerEventSourcePolling},
 * so a process implementation written against
 * {@link consumeServerEvents} chooses its transport entirely at Layer
 * composition: polling for a cheap laptop loop, the gateway for
 * instant delivery.
 *
 * One connection per Layer, shared by every registration:
 *
 * - resolve the socket URL (`GET /gateway/bot`, falling back to the
 *   well-known `wss://gateway.discord.gg` if REST is unreachable);
 * - HELLO → heartbeat loop at Discord's interval + IDENTIFY with the
 *   bot token and {@link ServerEventSourceGatewayOptions.intents};
 * - READY → capture the bot user (no REST round-trip needed);
 * - `MESSAGE_CREATE` dispatches fan out to registrations (filtered by
 *   their `serverId`), as gateway-shaped deliveries with
 *   DETERMINISTIC ids — `gateway/{channelId}/{messageId}`, a pure
 *   function of the message, so a ledger's dedupe holds across
 *   reconnects and restarts.
 *
 * Reconnect policy: any close, error, RECONNECT (op 7), or
 * INVALID SESSION (op 9) tears the connection down and a fresh
 * connect + IDENTIFY runs 5 seconds later, forever — resume (op 6)
 * is not implemented, so a reconnect may miss messages sent during
 * the gap (the polling Layer, or a Ledger fed by both, absorbs
 * this). The loop is owned by the Layer's Scope — closing the Scope
 * disconnects.
 *
 * Requires {@link DiscordCredentials} (`Discord.fromEnv()` reads
 * `DISCORD_BOT_TOKEN`) and an `HttpClient`. The websocket comes from
 * `globalThis.WebSocket` (present on bun, Node ≥ 22, and workerd).
 *
 * @example
 * ```typescript
 * const FactoryLocal = FrontDeskLive.pipe(
 *   Layer.provide(Discord.ServerEventSourceGateway()),
 *   Layer.provide(Discord.fromEnv()),
 * );
 * ```
 */
export const ServerEventSourceGateway = (
  options?: ServerEventSourceGatewayOptions,
): Layer.Layer<
  ServerEventSource,
  never,
  DiscordCredentials | HttpClient.HttpClient
> =>
  Layer.effect(
    ServerEventSource,
    Effect.gen(function* () {
      const credentials = yield* yield* DiscordCredentials;
      const client = yield* HttpClient.HttpClient;
      // the Layer's Scope owns the connection loop
      const scope = yield* Effect.scope;
      const intents = options?.intents ?? DEFAULT_INTENTS;
      const token = Redacted.value(credentials.token);

      interface Registration {
        readonly serverId?: string;
        readonly process: (
          event: GatewayDispatch,
        ) => Effect.Effect<void, never, never>;
      }
      const registrations = yield* Ref.make<ReadonlyArray<Registration>>([]);
      const botUserId = yield* Ref.make<string | null>(null);

      const gatewayUrl = yield* client
        .execute(
          HttpClientRequest.get("https://discord.com/api/v10/gateway/bot").pipe(
            HttpClientRequest.setHeaders({ Authorization: `Bot ${token}` }),
          ),
        )
        .pipe(
          Effect.flatMap((response) => response.json),
          Effect.map(
            (body) => (body as { url?: string }).url ?? GATEWAY_FALLBACK,
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              `Discord.ServerEventSourceGateway could not resolve the gateway URL (using ${GATEWAY_FALLBACK})`,
              error,
            ).pipe(Effect.as(GATEWAY_FALLBACK)),
          ),
        );

      const deliver = (message: GatewayMessage) =>
        Effect.gen(function* () {
          const bot = yield* Ref.get(botUserId);
          if (bot === null) return; // READY always precedes dispatches
          for (const registration of yield* Ref.get(registrations)) {
            if (
              registration.serverId !== undefined &&
              message.guild_id !== registration.serverId
            ) {
              continue;
            }
            yield* registration.process({
              id: `gateway/${message.channel_id}/${message.id}`,
              botUserId: bot,
              name: "MESSAGE_CREATE",
              payload: message,
            });
          }
        });

      // one connect → HELLO → IDENTIFY → dispatch session; any exit
      // (close, error, op 7/9) fails the effect so the retry reconnects
      const connection = Effect.gen(function* () {
        const connectionScope = yield* Effect.scope;
        const socket = yield* Socket.makeWebSocket(
          `${gatewayUrl}/?v=10&encoding=json`,
        );
        const write = yield* socket.writer;
        const sequence = yield* Ref.make<number | null>(null);

        const send = (frame: object) => write(JSON.stringify(frame));
        const heartbeat = Effect.gen(function* () {
          yield* send({ op: 1, d: yield* Ref.get(sequence) });
        });

        const handle = (raw: string) =>
          Effect.gen(function* () {
            const frame = yield* Effect.try({
              try: () => JSON.parse(raw) as GatewayFrame,
              catch: () => new Error(`unparseable gateway frame`),
            });
            switch (frame.op) {
              // HELLO: start the heartbeat, introduce ourselves
              case 10: {
                const interval = (frame.d as { heartbeat_interval: number })
                  .heartbeat_interval;
                yield* Effect.forkIn(
                  heartbeat.pipe(
                    Effect.repeat(Schedule.spaced(Duration.millis(interval))),
                  ),
                  connectionScope,
                );
                yield* send({
                  op: 2,
                  d: {
                    token,
                    intents,
                    properties: {
                      os: "alchemy",
                      browser: "alchemy",
                      device: "alchemy",
                    },
                  },
                });
                return;
              }
              // Discord asked for an immediate heartbeat
              case 1:
                return yield* heartbeat;
              // heartbeat ACK — nothing to do (zombie detection is
              // covered by the reconnect-on-close policy)
              case 11:
                return;
              // RECONNECT / INVALID SESSION: tear down, retry connects
              case 7:
              case 9:
                return yield* Effect.fail(
                  new Error(`gateway requested reconnect (op ${frame.op})`),
                );
              // dispatch
              case 0: {
                if (typeof frame.s === "number") {
                  yield* Ref.set(sequence, frame.s);
                }
                if (frame.t === "READY") {
                  const ready = frame.d as { user: { id: string } };
                  yield* Ref.set(botUserId, ready.user.id);
                  return;
                }
                if (frame.t === "MESSAGE_CREATE") {
                  return yield* deliver(frame.d as GatewayMessage);
                }
                return;
              }
              default:
                return;
            }
          });

        yield* socket.runString(handle);
        // a clean close still means the session is gone — reconnect
        return yield* Effect.fail(new Error("gateway connection closed"));
      }).pipe(
        Effect.scoped,
        Effect.tapError((error) =>
          Effect.logWarning(
            "Discord.ServerEventSourceGateway connection ended — reconnecting",
            error,
          ),
        ),
      );

      yield* Effect.forkIn(
        connection.pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
        ),
        scope,
      );

      return (<Req>(
        registration: { serverId?: string },
        process: (event: GatewayDispatch) => Effect.Effect<void, never, Req>,
      ) =>
        Ref.update(registrations, (current) => [
          ...current,
          {
            ...(registration.serverId !== undefined
              ? { serverId: registration.serverId }
              : {}),
            // Req is the registrar's phantom — deliveries close over
            // the ambient context the handler was registered in
            process: process as Registration["process"],
          },
        ])) as ServerEventSourceService;
    }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
  );
