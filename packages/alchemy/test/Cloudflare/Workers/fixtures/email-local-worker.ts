import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

interface ReceivedMessage {
  from: string;
  to: string;
  subject: string | null;
  bodySize: number;
}

/** Records every message the `email` subscribe handler sees. */
export class LocalInbox extends Cloudflare.DurableObject<LocalInbox>()(
  "LocalInbox",
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      let received =
        (yield* state.storage.get<ReceivedMessage[]>("received")) ?? [];
      return {
        record: Effect.fn(function* (msg: ReceivedMessage) {
          received = [...received, msg];
          yield* state.storage.put("received", received);
        }),
        snapshot: () => Effect.succeed({ received }),
        reset: Effect.fn(function* () {
          received = [];
          yield* state.storage.put("received", received);
        }),
      };
    });
  }),
) {}

/**
 * Fixture worker for `Email.local.test.ts`.
 *
 * Subscribes to inbound mail with the zone-less form of
 * `Cloudflare.email().subscribe(...)` (bring-your-own routing — no live
 * `Email.Routing`/`Email.Rule` API calls, so the fixture is safe in dev
 * mode). Messages are recorded on a DO; a `reject-me` subject exercises
 * the Effect-wrapped `setReject` path (the local trigger route answers
 * 400 with the reason).
 */
export default class EmailLocalWorker extends Cloudflare.Worker<EmailLocalWorker>()(
  "EmailLocalWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const inboxes = yield* LocalInbox;

    yield* Cloudflare.email().subscribe((message) =>
      Effect.gen(function* () {
        const subject = message.headers.get("subject");
        yield* inboxes.getByName("default").record({
          from: message.from,
          to: message.to,
          subject,
          bodySize: message.bodySize,
        });
        if (subject === "reject-me") {
          yield* message.setReject("rejected by EmailEventSource test");
        }
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/received") {
          const snapshot = yield* inboxes.getByName("default").snapshot();
          return yield* HttpServerResponse.json(snapshot);
        }

        if (request.method === "POST" && url.pathname === "/reset") {
          yield* inboxes.getByName("default").reset();
          return yield* HttpServerResponse.json({ ok: true });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
) {}
