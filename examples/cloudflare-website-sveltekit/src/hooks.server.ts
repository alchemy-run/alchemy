/**
 * The mount — kit's `handle` hook is where you own HTTP composition on
 * SvelteKit (kit's adapter owns the worker entry, so dispatch order,
 * gates, and effect routing live HERE, as ordinary hook code). Platform
 * handlers (queue consumer) and DO/Workflow class exports ride the
 * generated worker shim — derived from the backend program's `yield*`
 * registrations, never written here.
 */
import type { Handle } from "@sveltejs/kit";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

// The mount's claim is YOUR routing decision — the exclusion carves kit's
// own /api/processed (+server.ts) route back out of the effect API space.
const site = mount(Site, { routes: ["/api/*", "!/api/processed"] });

export const handle: Handle = async ({ event, resolve }) => {
  const { request } = event;
  const url = new URL(request.url);

  // Answered in the hook itself — no framework, no effect runtime.
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

  // Effect API first (undefined = "not mine"), then kit serves pages,
  // form actions, and +server.ts routes.
  return (
    (await site.fetch(request, event.platform?.env, event.platform?.ctx)) ??
    resolve(event)
  );
};
