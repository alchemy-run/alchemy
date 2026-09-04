import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { DiscordCredentials } from "./Credentials.ts";
import type { GatewayDispatch, GatewayMessage } from "./Events.ts";
import {
  ServerEventSource,
  type ServerEventSourceService,
} from "./ServerEventSource.ts";

export interface ServerEventSourcePollingOptions {
  /**
   * How often each registration polls the Discord REST API.
   * @default "15 seconds"
   */
  readonly every?: Duration.Input;
}

const API = "https://discord.com/api/v10";

/** Snowflake comparison — equal-length ids compare lexically; else by length. */
const newerThan = (a: string, b: string): boolean =>
  a.length === b.length ? a > b : a.length > b.length;

/**
 * A LOCAL, polling implementation of {@link ServerEventSource} — the
 * same tag a gateway-websocket or interactions-webhook Layer provides,
 * so a process implementation written against
 * {@link consumeServerEvents} runs on a laptop unchanged: the
 * environment is chosen entirely at Layer composition.
 *
 * Each registration forks a scoped poll loop (owned by the Layer's
 * Scope) that synthesizes gateway-shaped `MESSAGE_CREATE` deliveries
 * from the Discord REST API:
 *
 * - resolve the bot user (`GET /users/@me`) once at Layer build;
 * - enumerate servers (Discord's wire calls them guilds:
 *   `GET /users/@me/guilds`, or the registration's `serverId`) and
 *   their text channels + active threads each tick;
 * - fetch messages newer than each channel's cursor
 *   (`GET /channels/{id}/messages?after=…` — snowflake ids ARE the
 *   cursor, so ordering needs no clock).
 *
 * Fidelity limits (vs a real gateway): poll-interval latency, no
 * typing/presence events, and channels the bot cannot read are
 * silently skipped (403s are logged once per channel, not fatal).
 *
 * Delivery ids are DETERMINISTIC — `poll/{channelId}/{messageId}` — a
 * pure function of the message, never of poll time, so a ledger's
 * dedupe by delivery id holds across process restarts.
 *
 * Cursor state is in-memory per channel, starting at "now" (the
 * newest message id at registration): only NEW activity is observed.
 *
 * Requires {@link DiscordCredentials} (`Discord.fromEnv()` reads
 * `DISCORD_BOT_TOKEN`) and an `HttpClient`.
 *
 * @example
 * ```typescript
 * const FactoryLocal = FrontDeskLive.pipe(
 *   Layer.provide(Discord.ServerEventSourcePolling({ every: "10 seconds" })),
 *   Layer.provide(Discord.fromEnv()),
 * );
 * ```
 */
export const ServerEventSourcePolling = (
  options?: ServerEventSourcePollingOptions,
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
      // the Layer's Scope owns every registration's poll loop
      const scope = yield* Effect.scope;
      const every = options?.every ?? "15 seconds";

      const get = <A>(path: string): Effect.Effect<A, Error> =>
        client
          .execute(
            HttpClientRequest.get(`${API}${path}`).pipe(
              HttpClientRequest.setHeaders({
                Authorization: `Bot ${Redacted.value(credentials.token)}`,
              }),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? (response.json as Effect.Effect<unknown, unknown>)
                : Effect.fail(new Error(`GET ${path} → ${response.status}`)),
            ),
            Effect.mapError((cause) =>
              cause instanceof Error
                ? cause
                : new Error(`GET ${path} failed: ${cause}`),
            ),
          ) as Effect.Effect<A, Error>;

      const botUser = yield* get<{ id: string }>("/users/@me").pipe(
        Effect.orDie,
      );

      return (<Req>(
        registration: { serverId?: string },
        process: (event: GatewayDispatch) => Effect.Effect<void, never, Req>,
      ) =>
        Effect.gen(function* () {
          // channelId → newest seen message id; absent = first sighting
          const cursors = yield* Ref.make(new Map<string, string>());
          const warned = new Set<string>();

          const pollChannel = (channelId: string) =>
            Effect.gen(function* () {
              const seen = (yield* Ref.get(cursors)).get(channelId);
              const query =
                seen === undefined ? "?limit=1" : `?after=${seen}&limit=100`;
              const messages = yield* get<GatewayMessage[]>(
                `/channels/${channelId}/messages${query}`,
              );
              if (messages.length === 0) return;
              // newest first from the API — advance the cursor, then
              // deliver oldest→newest; first sighting only sets the
              // cursor (only NEW activity is observed)
              const newest = messages.reduce((max, message) =>
                newerThan(message.id, max.id) ? message : max,
              );
              yield* Ref.update(cursors, (map) =>
                new Map(map).set(channelId, newest.id),
              );
              if (seen === undefined) return;
              for (const message of [...messages].reverse()) {
                yield* process({
                  id: `poll/${channelId}/${message.id}`,
                  botUserId: botUser.id,
                  name: "MESSAGE_CREATE",
                  payload: { ...message, channel_id: channelId },
                });
              }
            }).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  // a channel the bot can't read is a fact, not a crash
                  if (warned.has(channelId)) return;
                  warned.add(channelId);
                  yield* Effect.logWarning(
                    `Discord.ServerEventSourcePolling cannot poll channel ${channelId}`,
                    error,
                  );
                }),
              ),
            );

          const listChannels = Effect.gen(function* () {
            const serverIds =
              registration.serverId !== undefined
                ? [registration.serverId]
                : (yield* get<{ id: string }[]>("/users/@me/guilds")).map(
                    (server) => server.id,
                  );
            const channels: string[] = [];
            for (const serverId of serverIds) {
              const serverChannels = yield* get<{ id: string; type: number }[]>(
                `/guilds/${serverId}/channels`,
              );
              // 0 = text, 5 = announcement
              channels.push(
                ...serverChannels
                  .filter((channel) => channel.type === 0 || channel.type === 5)
                  .map((channel) => channel.id),
              );
              const threads = yield* get<{
                threads: { id: string }[];
              }>(`/guilds/${serverId}/threads/active`);
              channels.push(...threads.threads.map((thread) => thread.id));
            }
            return channels;
          });

          const pollOnce = Effect.gen(function* () {
            const channels = yield* listChannels;
            // sequential — bounded, and kind to Discord's rate limits
            for (const channelId of channels) {
              yield* pollChannel(channelId);
            }
          }).pipe(
            // a failed poll (network, rate limit) never kills the loop —
            // the next tick retries from the same cursors
            Effect.catch((error) =>
              Effect.logWarning(
                "Discord.ServerEventSourcePolling poll failed",
                error,
              ),
            ),
          );

          yield* Effect.forkIn(
            pollOnce.pipe(Effect.repeat(Schedule.spaced(every))),
            scope,
          );
        })) as ServerEventSourceService;
    }),
  );
