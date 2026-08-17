/**
 * The worker entry — YOURS (`server.entry` on the Site class). You own
 * HTTP composition: dispatch order, gates, and custom routes are ordinary
 * code around `site.fetch`, and the framework serves whatever you fall
 * through to. Platform handlers (queue consumer) and DO/Workflow class
 * exports ride the generated wrapper around this module — derived from
 * the backend program's `yield*` registrations, never written here.
 */
import serverEntry from "@tanstack/react-start/server-entry";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

// Start's type is request-only, but on workerd the exported-handler triple
// is what arrives — pass it through (extra args are ignored where unused).
const framework = serverEntry as {
  fetch: (
    request: Request,
    env?: unknown,
    ctx?: unknown,
  ) => Response | Promise<Response>;
};

export default {
  fetch: async (
    request: Request,
    env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> => {
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

    // Effect API first (undefined = "not mine"), then the framework
    // serves pages, assets, and TanStack server functions.
    return (
      (await site.fetch(request, env, ctx)) ??
      framework.fetch(request, env, ctx)
    );
  },
};
