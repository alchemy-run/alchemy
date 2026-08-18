/**
 * The mount — on Next.js, a route file owns HTTP composition
 * (Serve/DESIGN.md): this optional catch-all claims /api/*, and inside
 * the claim the effect fetch is authoritative.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` and the request scope settles inline before the response
 * — Lambda semantics.
 */
import { mount } from "alchemy/Serve";
import Site from "../../../src/backend.ts";

const site = mount(Site);

// Route handlers must never prerender at build time — there is no backend
// (and no stack markers) inside `next build`.
export const dynamic = "force-dynamic";

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
