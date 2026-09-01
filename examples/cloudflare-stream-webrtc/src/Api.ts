import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Broadcast } from "./Broadcast.ts";
import { PAGE } from "./page.ts";

const whipUrl = Config.redacted("WHIP_URL");
const whepUrl = Config.string("WHEP_URL");
const broadcastKey = Config.redacted("BROADCAST_KEY");

/**
 * A Worker that fronts a Stream live input's WebRTC endpoints.
 *
 * The two URLs are handled very differently on purpose:
 *
 * - `webRTCPlaybackUrl` (WHEP) is what viewers connect to, so `/whep` just
 *   hands it out and the browser negotiates with Cloudflare directly.
 * - `webRTCUrl` (WHIP) embeds a secret that grants publish access to this
 *   input. It is bound as a `Redacted` secret and never leaves the Worker —
 *   `/whip` authorizes the caller first, then proxies the SDP offer.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const broadcast = yield* Broadcast;

    return {
      main: import.meta.url,
      env: {
        // Cloudflare minted both of these when the live input was created.
        // `webRTCUrl` is Redacted, so it deploys as a `secret_text` binding.
        WHIP_URL: broadcast.webRTCUrl,
        WHEP_URL: broadcast.webRTCPlaybackUrl,
        // Whatever you already use to decide who may broadcast. A shared
        // key keeps the example to one moving part.
        BROADCAST_KEY: Redacted.make("dev-broadcast-key"),
      },
    };
  }),
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const { pathname } = new URL(request.originalUrl);

        // Public: viewers need this to play, and it is safe to hand out.
        if (pathname === "/whep") {
          return yield* HttpServerResponse.json({ url: yield* whepUrl });
        }

        // Gated: proxies a WHIP offer to the secret publish URL. Swap the
        // bearer check for your real authorization before shipping.
        if (pathname === "/whip" && request.method === "POST") {
          const key = yield* broadcastKey;
          if (
            request.headers.authorization !== `Bearer ${Redacted.value(key)}`
          ) {
            return HttpServerResponse.text("not allowed to broadcast", {
              status: 403,
            });
          }

          const offer = yield* request.text;
          const upstream = yield* client.execute(
            HttpClientRequest.post(Redacted.value(yield* whipUrl)).pipe(
              HttpClientRequest.bodyText(offer, "application/sdp"),
            ),
          );

          return HttpServerResponse.text(yield* upstream.text, {
            status: upstream.status,
            contentType: "application/sdp",
          });
        }

        return HttpServerResponse.html(PAGE);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`error: ${cause}`, { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
