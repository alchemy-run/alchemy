import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EventWebhook } from "./EventWebhook.ts";
import { PublicKey } from "./internal/PublicKey.ts";
import { verifyDiscordSignature } from "./internal/Signature.ts";
import {
  WebhookEvents,
  webhookEventsPath,
  type WebhookEvent,
  type WebhookEventsProps,
  type WebhookEventsService,
} from "./WebhookEvents.ts";

/**
 * Discord webhook events on any {@link WebhookHost} (every Cloudflare Worker
 * is one).
 *
 * Deploy time: binds the application's public key into the host and
 * registers `${host.url}${path}` with the selected event types (after the
 * host serves the route, which Discord's PING needs). Run time: verifies each
 * delivery's Ed25519 signature, answers PINGs, and runs the handler.
 *
 * @layer
 * @product Interaction
 * @provides Discord.WebhookEvents
 */
export const WebhookEventsLive = Layer.effect(
  WebhookEvents,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    const makeKey = yield* PublicKey;
    const makeWebhook = yield* EventWebhook;

    return Effect.fn(function* (
      props: WebhookEventsProps,
      handler: (event: WebhookEvent) => Effect.Effect<void, never, never>,
    ) {
      const path = webhookEventsPath(props);
      const key = yield* Namespace.push(host.LogicalId, makeKey("DiscordPublicKey", {}));
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.asVoid(
            makeWebhook("DiscordEventWebhook", {
              url: Output.interpolate`${host.url}${path}`,
              types: [...props.types],
            }),
          ),
        );
      }
      const publicKey = yield* Output.named(key.publicKey, "DISCORD_PUBLIC_KEY");
      yield* host.route(path, (request) =>
        Effect.gen(function* () {
          if (request.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
          }
          const body = yield* Effect.tryPromise(() => request.text()).pipe(
            Effect.orElseSucceed(() => ""),
          );
          const k = yield* publicKey;
          if (!k || !(yield* verifyDiscordSignature(k, request, body))) {
            return new Response("invalid request signature", { status: 401 });
          }
          const payload = yield* Effect.try(
            () => JSON.parse(body) as { type: 0 | 1; event?: WebhookEvent },
          ).pipe(Effect.orElseSucceed(() => undefined));
          if (payload === undefined) return new Response("bad request", { status: 400 });
          // type 0 is Discord's PING; type 1 carries an event.
          if (payload.type === 1 && payload.event !== undefined) yield* handler(payload.event);
          return new Response(null, { status: 204 });
        }),
      );
    }) as WebhookEventsService;
  }),
);
