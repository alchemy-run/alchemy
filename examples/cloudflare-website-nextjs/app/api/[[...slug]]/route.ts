/**
 * The mount — on Next.js, a route file is where you own HTTP composition
 * (the file's location IS the routing: this optional catch-all claims
 * /api and everything under it that no more-specific route file serves).
 * Platform handlers (queue consumer) and DO/Workflow class exports ride
 * the generated worker entry — derived from the backend program's
 * `yield*` registrations, never written here.
 */
import { mount } from "alchemy/Serve";
import Site from "../../backend.ts";

// The mount's claim is YOUR routing decision — the exclusion carves Next's
// own /api/jobs route handler (app/api/jobs/route.ts) back out of the
// effect API space. (Next already prefers the more specific route file;
// the exclusion keeps the claim honest for callers of this handler.)
const site = mount(Site, { routes: ["/api/*", "!/api/jobs"] });

// Route handlers must never prerender at build time — there is no backend
// (and no stack markers) inside `next build`.
export const dynamic = "force-dynamic";

// Effect API first (undefined = "not mine"); inside the claim the effect
// fetch is authoritative, so a miss is a real 404, never Next's HTML page.
const handler = async (req: Request): Promise<Response> =>
  (await site.fetch(req)) ?? new Response("Not Found", { status: 404 });

export {
  handler as DELETE,
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
