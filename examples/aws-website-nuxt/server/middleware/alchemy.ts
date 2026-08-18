/**
 * The mount — a nitro server middleware is where you own HTTP composition
 * on Nuxt (nitro owns the Lambda entry, so dispatch order, gates, and
 * effect routing live HERE, as ordinary middleware code). Platform
 * handlers (the queue consumer) ride the generated single-handler Lambda
 * entry — derived from the backend program's `yield*` registrations,
 * never written here.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` (the Lambda sandbox env, or the dev-server process env
 * `alchemy dev` lowered the same values into), and the request scope
 * settles inline before the response — Lambda semantics.
 *
 * Returning `undefined` lets nitro continue to its own routes (the
 * server/api/ handlers, SSR pages, static assets).
 */
import { mount } from "alchemy/Serve";
import { defineEventHandler, toWebRequest } from "h3";
import Site from "../backend.ts";

// The mount's claim is YOUR routing decision — the exclusions carve
// nitro's own /api/jobs and /api/visits routes back out of the effect API
// space.
const site = mount(Site, {
  routes: ["/api/*", "!/api/jobs", "!/api/visits"],
});

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  const url = new URL(request.url);

  // Answered in the middleware itself — no framework, no effect runtime.
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

  // Effect API first (undefined = "not mine"), then nitro serves its own
  // routes and pages.
  return site.fetch(request);
});
