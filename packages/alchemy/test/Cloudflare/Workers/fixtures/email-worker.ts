import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Zone the fixture subscribes on. Resolved via Effect `Config` at the
 * Init phase, which makes Alchemy bind the resolved value as `plain_text`
 * on the Worker — at runtime the same `Config` call re-resolves from that
 * binding via the runtime `ConfigProvider`.
 */
const ZoneConfig = Config.string("CLOUDFLARE_TEST_DNS_ZONE_NAME").pipe(
  Config.withDefault("alchemy-test-2.us"),
);

interface ReceivedMessage {
  from: string;
  to: string;
  subject: string | null;
  bodySize: number;
  receivedAt: number;
}

/**
 * Durable Object that records every message the worker's email handler
 * sees. The test polls `snapshot()` via `GET /received` to confirm the
 * inbound dispatch actually fired.
 */
export class Inbox extends Cloudflare.DurableObject<Inbox>()(
  "Inbox",
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
 * Fixture worker for `Email.test.ts`.
 *
 * Wires `Cloudflare.email({ zone, matchers }).subscribe(...)` to record
 * each inbound message on an `Inbox` DO. The deploy-time half of the
 * event source auto-creates the `Email.Routing` toggle and the
 * `Email.Rule` routing `email-events@<zone>` to this Worker, so the test
 * stack needs no hand-rolled routing wiring.
 *
 * Routes:
 *
 * - `GET /received` — snapshot of recorded inbound messages.
 * - `POST /reset` — clear the DO state (doubles as the readiness probe).
 */
export default class EmailTestWorker extends Cloudflare.Worker<EmailTestWorker>()(
  "EmailTestWorker",
  {
    main: import.meta.filename,
    workersDev: { enabled: true, previewsEnabled: false },
  },
  Effect.gen(function* () {
    const inboxes = yield* Inbox;

    const zone = yield* ZoneConfig;
    const inboxAddress = `email-events@${zone}`;

    yield* Cloudflare.email({
      zone,
      matchers: [{ type: "literal", field: "to", value: inboxAddress }],
    }).subscribe((message) =>
      inboxes.getByName("default").record({
        from: message.from,
        to: message.to,
        subject: message.headers.get("subject"),
        bodySize: message.bodySize,
        receivedAt: Date.now(),
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
