import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./agent.ts";

/**
 * HTTP/WebSocket front for the {@link Agent} Durable Object. Routes
 * `/agent/:id/:action` to the matching DO instance: `/connect` (with
 * `Upgrade: websocket`) is forwarded to the DO's `fetch` so it can complete the
 * WebSocket handshake and stream events; the rest invoke the DO's typed RPC
 * methods (`send`, `interrupt`, `poll`, `file`, `files`), serializing the result
 * as JSON. The worker is the only place that speaks HTTP.
 */
export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const agents = yield* Agent;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://agent");
        const [prefix, id, action] = url.pathname.split("/").filter(Boolean);

        if (prefix !== "agent" || !id) {
          return HttpServerResponse.text("ok");
        }

        const agent = agents.getByName(id);

        // WebSocket upgrade: hand the raw request to the DO, which completes the
        // handshake and starts streaming agent events back over the socket.
        if (request.headers.upgrade === "websocket") {
          return yield* agent.fetch(request);
        }

        switch (action) {
          case "send": {
            const prompt = url.searchParams.get("prompt") ?? "";
            const model = url.searchParams.get("model") ?? undefined;
            yield* agent.send({ prompt, model });
            return yield* HttpServerResponse.json({ ok: true });
          }
          case "interrupt": {
            yield* agent.interrupt();
            return yield* HttpServerResponse.json({ ok: true });
          }
          case "events": {
            const cursor = Number(url.searchParams.get("cursor") ?? "0") || 0;
            const page = yield* agent.poll(cursor);
            return yield* HttpServerResponse.json(page);
          }
          case "file": {
            const path = url.searchParams.get("path") ?? "";
            const contents = yield* agent.readFile(path);
            return yield* HttpServerResponse.json({ contents });
          }
          case "files": {
            const path = url.searchParams.get("path") ?? undefined;
            const files = yield* agent.listFiles(path);
            return yield* HttpServerResponse.json({ files });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }),
);
