/**
 * The mount — Astro 7's native fetch entrypoint (`fetchFile`, default
 * `src/fetch.ts`) owns HTTP composition (Serve/DESIGN.md): effect API
 * first (`undefined` = "not mine"), then Astro's pipeline serves pages.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` and the request scope settles inline before the response
 * — Lambda semantics.
 */
import { FetchState, astro } from "astro/fetch";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

export default {
  fetch: async (request: Request): Promise<Response> =>
    (await site.fetch(request)) ?? astro(new FetchState(request)),
};
