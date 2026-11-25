import * as Docker from "@alchemy.run/docker";
import * as Mux from "@alchemy.run/mux";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Key = Mux.System.SigningKey("Key");

export const Hook = Mux.System.Webhook("Hook", {
  address: "https://alchemy-test.example.com/mux/bindings-host",
});

/**
 * A local Docker service that binds a signing key and a webhook, so both
 * bindings run in a deployed host with only what reached its environment.
 *
 * - `GET /sign?playback_id=…&type=…&expires_in=…&time=…` answers a token.
 * - `POST /verify` answers 204 when the `mux-signature` header matches the
 *   body, or 401 with the reason.
 */
export default class MuxBindingsHost extends Docker.Service<MuxBindingsHost>()(
  "MuxBindingsHost",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ internal: 3000 }],
    replicas: 1,
  },
  Effect.gen(function* () {
    const key = yield* Key;
    const hook = yield* Hook;
    const signer = yield* Mux.Video.PlaybackSigner(key);
    const verifier = yield* Mux.System.WebhookVerifier(hook);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://host");
        if (url.pathname === "/health") return HttpServerResponse.text("ok");
        if (url.pathname === "/sign") {
          const time = url.searchParams.get("time");
          const token = yield* signer.sign(url.searchParams.get("playback_id") ?? "", {
            type: (url.searchParams.get("type") as Mux.Video.TokenType | null) ?? undefined,
            expiresIn: Number(url.searchParams.get("expires_in") ?? 3600),
            claims: time === null ? undefined : { time: Number(time) },
          });
          return HttpServerResponse.text(token);
        }
        if (url.pathname === "/verify") {
          const body = yield* request.text;
          const header = request.headers["mux-signature"];
          return yield* verifier.verify(body, header).pipe(
            Effect.as(HttpServerResponse.empty({ status: 204 })),
            Effect.catchTag("Mux.WebhookSignatureInvalid", (error) =>
              Effect.succeed(HttpServerResponse.text(error.reason, { status: 401 })),
            ),
          );
        }
        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(Mux.Video.PlaybackSignerLive),
    Effect.provide(Mux.System.WebhookVerifierLive),
  ),
) {}
