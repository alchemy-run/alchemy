import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * A zone that does not exist. Under `alchemy dev` the event source must not
 * provision Email Routing for a local Worker, so deploying never looks this
 * zone up; if it did, the deploy would fail instead of routing a real zone's
 * mail to a script that was never uploaded.
 */
export const LocalEmailZone = "alchemy-email-dev.invalid";

interface Received {
  readonly from: string;
  readonly to: string;
  readonly subject: string | null;
}

// One workerd isolate serves the local Worker, so module state survives
// between the trigger request and the `/received` read.
const received: Array<Received> = [];

/**
 * An Effect-native Worker that subscribes to inbound email, for the local
 * `/cdn-cgi/handler/email` trigger route. The local runtime calls the
 * Worker's `email()` over JSRPC, unlike `fetch` and `scheduled`.
 */
export default class EmailLocalWorker extends Cloudflare.Worker<EmailLocalWorker>()(
  "EmailLocalWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    // `remote()` around the subscription alone leaves the Worker local, so
    // it still provisions no routing.
    yield* Cloudflare.email({ zone: LocalEmailZone })
      .subscribe((message) =>
        Effect.gen(function* () {
          const subject = message.headers.get("subject");
          if (subject === "reject-me") {
            return yield* message.setReject("not on the list");
          }
          received.push({ from: message.from, to: message.to, subject });
        }),
      )
      .pipe(Alchemy.remote());

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/received")) {
          return yield* HttpServerResponse.json(received);
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
) {}
