import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.ts";

const VIAS = ["binding", "fetch", "rpc"] as const;
type Via = (typeof VIAS)[number];

const parseRequest = (request: Request): { via: Via; key: string | null } => {
  const url = new URL(request.url);
  const raw = url.searchParams.get("via") ?? "binding";
  const via = (VIAS as readonly string[]).includes(raw)
    ? (raw as Via)
    : "binding";
  return { via, key: url.searchParams.get("key") };
};

export const Route = createFileRoute("/api/hello")({
  server: {
    handlers: {
      // GET /api/hello?key=<key>&via=binding|fetch|rpc
      GET: async ({ request }) => {
        const { via, key } = parseRequest(request);
        if (!key) {
          return new Response("Missing 'key' query parameter", { status: 400 });
        }

        switch (via) {
          // option 1 — use the async binding directly
          case "binding": {
            const object = await env.BUCKET.get(key);
            if (!object) return new Response("Not found", { status: 404 });
            return new Response(object.body);
          }

          // option 2 — bind to your effect worker and call fetch
          case "fetch": {
            return env.BACKEND.fetch(
              `https://backend/?key=${encodeURIComponent(key)}`,
            );
          }

          // option 3 — bind to your effect worker and call rpc method
          case "rpc": {
            const value = await env.BACKEND.hello(key);
            if (value === null)
              return new Response("Not found", { status: 404 });
            return new Response(value);
          }
        }
      },

      // PUT /api/hello?key=<key>&via=binding|fetch
      // (option 3 is GET-only — `hello` is a read RPC for demonstration.)
      PUT: async ({ request }) => {
        const { via, key } = parseRequest(request);
        if (!key) {
          return new Response("Missing 'key' query parameter", { status: 400 });
        }
        if (!request.body) {
          return new Response("Missing request body", { status: 400 });
        }

        switch (via) {
          // option 1 — use the async binding directly
          case "binding": {
            await env.BUCKET.put(key, request.body, {
              httpMetadata: {
                contentType:
                  request.headers.get("content-type") ??
                  "application/octet-stream",
              },
            });
            return new Response(null, { status: 204 });
          }

          // option 2 — bind to your effect worker and call fetch
          case "fetch": {
            return env.BACKEND.fetch(
              `https://backend/?key=${encodeURIComponent(key)}`,
              {
                method: "PUT",
                body: request.body,
                headers: request.headers,
              },
            );
          }

          // option 3 — RPC `hello` is read-only
          case "rpc": {
            return new Response("PUT is not supported via=rpc", {
              status: 400,
            });
          }
        }
      },
    },
  },
});
