import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import { Agent } from "./Agent.ts";

const encoder = new TextEncoder();

/**
 * A small HTTP API over many coding agents:
 *
 *   POST /agents/:id          { prompt }  start the session (idempotent) and run a turn → result
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
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://agents");
        const match = /^\/agents\/([\w-]+)(?:\/(steer|interrupt|events|model))?$/.exec(
          url.pathname,
        );
        if (!match) return HttpServerResponse.text("POST /agents/:id { prompt }", { status: 404 });
        const [, id, action] = match;

        if (action === "events") {
          const after = Number(url.searchParams.get("after") ?? 0);
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
        const result = yield* agent.result({ turnId: turn.turnId });
        return yield* HttpServerResponse.json(result);
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }),
);
