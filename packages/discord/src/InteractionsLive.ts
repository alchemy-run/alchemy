import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { WebhookHost } from "alchemy/WebhookHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Interactions,
  interactionsPath,
  type Interaction,
  type InteractionResponse,
  type InteractionsProps,
  type InteractionsService,
} from "./Interactions.ts";
import { InteractionsEndpoint } from "./InteractionsEndpoint.ts";
import { PublicKey } from "./internal/PublicKey.ts";
import { verifyDiscordSignature } from "./internal/Signature.ts";

/**
 * Discord interactions on any {@link WebhookHost} (every Cloudflare Worker is
 * one).
 *
 * Deploy time: records the application's public key and binds it into the
 * host, then registers `${host.url}${path}` as the application's
 * interactions endpoint. The endpoint depends on the host's URL, so it is
 * set after the host serves the verifying route, which Discord's PING needs.
 *
 * Run time: claims POSTs on the path, verifies the Ed25519 signature,
 * answers PINGs, and returns the handler's answer for everything else.
 *
 * @layer
 * @product Interaction
 * @provides Discord.Interactions
 */
export const InteractionsLive = Layer.effect(
  Interactions,
  Effect.gen(function* () {
    const host = yield* WebhookHost;
    const makeKey = yield* PublicKey;
    const makeEndpoint = yield* InteractionsEndpoint;

    return Effect.fn(function* (
      props: InteractionsProps,
      handler: (interaction: Interaction) => Effect.Effect<InteractionResponse, never, never>,
    ) {
      const path = interactionsPath(props);
      const key = yield* Namespace.push(host.LogicalId, makeKey("DiscordPublicKey", {}));
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.asVoid(
            makeEndpoint("DiscordInteractionsEndpoint", {
              url: Output.interpolate`${host.url}${path}`,
            }),
          ),
        );
      }
      const publicKey = yield* Output.named(key.publicKey, "DISCORD_PUBLIC_KEY");
      yield* host.route(path, (request) => handleInteraction(request, publicKey, handler));
    }) as InteractionsService;
  }),
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const handleInteraction = <Req>(
  request: Request,
  publicKey: Effect.Effect<string | undefined>,
  handler: (interaction: Interaction) => Effect.Effect<InteractionResponse, never, Req>,
): Effect.Effect<Response, never, Req> =>
  Effect.gen(function* () {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = yield* Effect.tryPromise(() => request.text()).pipe(
      Effect.orElseSucceed(() => ""),
    );
    const key = yield* publicKey;
    if (!key || !(yield* verifyDiscordSignature(key, request, body))) {
      return new Response("invalid request signature", { status: 401 });
    }
    const interaction = yield* Effect.try(() => JSON.parse(body) as Interaction | { type: 1 }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (interaction === undefined) return new Response("bad request", { status: 400 });
    // PING: Discord checking the endpoint.
    if (interaction.type === 1) return json({ type: 1 });
    return json(yield* handler(interaction as Interaction));
  });
