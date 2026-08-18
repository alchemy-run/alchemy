/**
 * The mount — Astro 7's native fetch entrypoint (`fetchFile`, default
 * `src/fetch.ts`): you own HTTP composition. Dispatch order, gates, and
 * custom routes are ordinary code around `site.fetch`, and Astro's whole
 * pipeline (pages, actions) serves whatever you fall through to.
 * Platform handlers (queue consumer) and DO/Workflow class exports ride
 * the generated worker entry — derived from the backend program's
 * `yield*` registrations, never written here.
 */
import { FetchState, astro } from "astro/fetch";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

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

    // A gate ahead of both worlds: /api/admin/* requires a header.
    if (
      url.pathname.startsWith("/api/admin") &&
      request.headers.get("x-admin-key") !== "letmein"
    ) {
      return new Response("forbidden", { status: 403 });
    }

    // Effect API first (undefined = "not mine"), then Astro serves pages
    // and actions.
    return (
      (await site.fetch(request, env, ctx)) ?? astro(new FetchState(request))
    );
  },
};
