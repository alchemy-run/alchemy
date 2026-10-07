import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { Agent } from "./Agent.ts";

const encoder = new TextEncoder();

/** The web UI is served from another origin. */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, last-event-id",
};

/**
 * A small HTTP API over many coding agents:
 *
 *   POST /agents/:id          { prompt }  start the session (idempotent) and run a turn → result
 *                                         (`?wait=false` returns as soon as the turn starts)
 *   POST /agents/:id/steer    { prompt }  redirect the running turn
 *   POST /agents/:id/interrupt            stop the running turn
 *   POST /agents/:id/model    { model }   switch models mid-session
 *   GET  /agents/:id                      session info (state, model, usage)
 *   GET  /agents/:id/events?after=N       server-sent events, resumable by cursor
 *
 * Each agent is its own Durable Object + container. For a browser, connect
 * straight to the DO over a hibernating WebSocket with `agents.fetch(id, request)`.
 */
export default Cloudflare.Worker(
  "CodingAgents",
  // Under `alchemy dev` the web UI takes the default port.
  { main: import.meta.url, dev: { port: 1338 } },
  Effect.gen(function* () {
    const agents = yield* Agent;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204 });
        const url = new URL(request.url, "http://agents");
        const match = /^\/agents\/([\w-]+)(?:\/(steer|interrupt|events|model))?$/.exec(
          url.pathname,
        );
        if (!match) return HttpServerResponse.text("POST /agents/:id { prompt }", { status: 404 });
        const [, id, action] = match;

        if (action === "events") {
          // `EventSource` reconnects with `Last-Event-ID` (our cursor).
          const after = Number(
            request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
          );
          // The body is read after this handler returns, so the stream opens
          // (and owns) its own connection to the agent.
          const events = Stream.unwrap(
            Effect.map(agents.getByName(id!), (agent) => agent.events({ after })),
          ).pipe(Stream.scoped);
          return HttpServerResponse.stream(
            events.pipe(
              Stream.map((event) =>
                encoder.encode(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`),
              ),
            ),
            { contentType: "text/event-stream" },
          );
        }
        const agent = yield* agents.getByName(id!);
        if (request.method === "GET" && action === undefined) {
          return yield* HttpServerResponse.json(yield* agent.info());
        }
        if (action === "interrupt") {
          yield* agent.interrupt();
          return HttpServerResponse.empty({ status: 202 });
        }
        if (action === "model") {
          const { model } = (yield* request.json) as { model: string };
          yield* agent.setModel({ model });
          return HttpServerResponse.empty({ status: 202 });
        }
        const { prompt } = (yield* request.json) as { prompt: string };
        if (action === "steer") {
          yield* agent.steer({ prompt });
          return HttpServerResponse.empty({ status: 202 });
        }
        yield* agent.start({});
        const turn = yield* agent.prompt({ prompt });
        if (url.searchParams.get("wait") === "false") return yield* HttpServerResponse.json(turn);
        const result = yield* agent.result({ turnId: turn.turnId });
        return yield* HttpServerResponse.json(result);
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
        Effect.map(HttpServerResponse.setHeaders(cors)),
      ),
    };
  }),
);
