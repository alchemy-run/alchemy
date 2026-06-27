import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import Agent from "./agent.ts";
import playground from "./index.html?raw";

/**
 * HTTP/WebSocket front for the {@link Agent} Durable Object.
 *
 * The root path serves a self-contained SPA ({@link playground}) for poking at
 * the agent by hand. `/agent/:id/connect` performs a WebSocket upgrade
 * forwarded to the DO's `fetch` (which streams the agent's event log over the
 * socket). The control routes — `send`, `interrupt`, `events`, `file`,
 * `files` — invoke the DO's typed RPC methods.
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
          return HttpServerResponse.html(playground);
        }

        const agent = agents.getByName(id);

        // WebSocket upgrade: hand the raw request to the DO, which completes the
        // handshake and starts streaming the agent's event log over the socket.
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
          case "sessions": {
            const sessions = yield* agent.listSessions();
            const current = yield* agent.currentSession();
            return yield* HttpServerResponse.json({ sessions, current });
          }
          case "switch": {
            const requested = url.searchParams.get("id") ?? undefined;
            const current = yield* agent.switchSession(requested);
            return yield* HttpServerResponse.json({ current });
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
