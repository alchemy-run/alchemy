import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Slack from "@alchemy.run/slack";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Logical ID of the app `consumeEvents` creates inside the Worker. */
export const EventsAppId = "EventsApp";

// Receives `app_mention` deliveries and records the last one in KV, so the
// test can read back what the handler saw.
export default class SlackEventsWorker extends Cloudflare.Worker<SlackEventsWorker>()(
  "SlackEventsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const log = yield* Cloudflare.KV.Namespace("SlackEventLog");
    const kv = yield* Cloudflare.KV.ReadWriteNamespace(log);

    yield* Slack.consumeEvents(
      EventsAppId,
      {
        manifest: {
          display_information: { description: "alchemy consumeEvents test" },
          features: { bot_user: { display_name: "alchemy-events-test" } },
          oauth_config: { scopes: { bot: ["app_mentions:read"] } },
        },
        events: ["app_mention"],
      },
      Effect.fn(function* (delivery) {
        yield* kv
          .put(
            delivery.event_id,
            JSON.stringify({ type: delivery.event.type, text: delivery.event.text }),
          )
          .pipe(Effect.orDie);
      }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/seen/")) {
          const id = request.url.slice("/seen/".length).split("?")[0]!;
          const seen = yield* kv.get(id).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ seen: seen === null ? null : JSON.parse(seen) });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.KV.ReadWriteNamespaceBinding, Slack.ConsumeEventsLive),
    ),
  ),
) {}
