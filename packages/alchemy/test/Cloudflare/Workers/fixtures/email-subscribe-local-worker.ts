import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

interface ReceivedMessage {
  from: string;
  to: string;
  subject: string | null;
  bodySize: number;
  body: string;
}

/**
 * Effect-native Worker driven through `Cloudflare.email().subscribe(...)`,
 * exercised against the local simulator rather than a deployed Worker.
 *
 * `zone` is deliberately omitted: under `alchemy dev` the event source skips
 * the deploy-time half anyway, and leaving it out keeps this fixture from
 * naming a real zone. The runtime listener is what's under test — the local
 * runtime's `POST /cdn-cgi/handler/email` trigger route dispatches to the
 * same `email` export the deployed Worker uses.
 */
export default class EmailSubscribeLocalWorker extends Cloudflare.Worker<EmailSubscribeLocalWorker>()(
  "EmailSubscribeLocalWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const received: ReceivedMessage[] = [];

    yield* Cloudflare.email().subscribe((message) =>
      Effect.gen(function* () {
        // Reject on demand so the trigger route's 400-with-reason path is
        // covered alongside the accept path.
        const subject = message.headers.get("subject");
        if (subject === "reject-me") {
          return yield* message.setReject("I don't like this email");
        }
        const body = yield* Effect.promise(() =>
          new Response(message.body as any).text(),
        );
        received.push({
          from: message.from,
          to: message.to,
          subject,
          bodySize: message.bodySize,
          body,
        });
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/received") {
          return yield* HttpServerResponse.json({ received });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
) {}
