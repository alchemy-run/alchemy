/**
 * The server entry — YOURS (TanStack Start's `src/server.ts` convention;
 * Start builds it as the server entry in dev AND prod, so the same file
 * runs everywhere). You own HTTP composition: dispatch order, gates, and
 * custom routes are ordinary code around `site.fetch`, and the framework
 * serves whatever you fall through to. On AWS the platform handlers
 * (queue consumer) ride the generated Lambda entry around this module —
 * derived from the backend program's `yield*` registrations, never
 * written here.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` (the Lambda sandbox env, or the dev-server process env
 * `alchemy dev` lowered the same values into), and the request scope
 * settles inline before the response — Lambda semantics.
 */
import serverEntry from "@tanstack/react-start/server-entry";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

const framework = serverEntry as {
  fetch: (request: Request) => Response | Promise<Response>;
};

export default {
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    // Answered in the entry itself — no framework, no effect runtime.
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    // A gate ahead of BOTH worlds: /api/admin/* requires a header.
    if (
      url.pathname.startsWith("/api/admin") &&
      request.headers.get("x-admin-key") !== "letmein"
    ) {
      return new Response("forbidden", { status: 403 });
    }

    // `site.fetch` resolves the Response for paths the mount claims and
    // `undefined` for everything else (the ServeHandle.fetch contract —
    // decline, not error), so `??` composes the framework as fallback.
    return (await site.fetch(request)) ?? framework.fetch(request);
  },
};
