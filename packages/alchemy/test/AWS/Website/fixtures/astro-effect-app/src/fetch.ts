/**
 * The mount (Serve/DESIGN.md) — Astro's native fetch entrypoint
 * (`fetchFile`, default `src/fetch.ts`) owns HTTP composition. The claim
 * mirrors the construct's `server.routes` (the exclusion carves Astro's
 * own /api/astro-echo endpoint back out); on AWS `site.fetch` takes no
 * env/ctx — env resolves from `process.env` and the request scope settles
 * inline.
 */
import { FetchState, astro } from "astro/fetch";
import { mount } from "alchemy/Serve";
import Site from "../site.ts";

const site = mount(Site, { routes: ["/api/*", "!/api/astro-echo"] });

export default {
  fetch: async (request: Request): Promise<Response> =>
    (await site.fetch(request)) ?? astro(new FetchState(request)),
};
