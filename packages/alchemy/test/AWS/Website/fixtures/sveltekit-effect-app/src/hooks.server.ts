/**
 * The mount (Serve/DESIGN.md) — kit's `handle` hook owns HTTP composition.
 * The claim mirrors the construct's `server.routes` (the exclusion carves
 * kit's own /api/hello +server endpoint back out); on AWS `site.fetch`
 * takes no env/ctx — env resolves from `process.env` and the request
 * scope settles inline.
 */
import { mount } from "alchemy/Serve";
import Site from "./site.ts";

const site = mount(Site, { routes: ["/api/*", "!/api/hello"] });

export const handle = async ({
  event,
  resolve,
}: {
  event: { request: Request };
  resolve: (event: unknown) => Promise<Response>;
}): Promise<Response> => (await site.fetch(event.request)) ?? resolve(event);
