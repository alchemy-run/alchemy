/**
 * The mount (Serve/DESIGN.md) — Astro 7's native fetch entrypoint
 * (`fetchFile`, default `src/fetch.ts`) owns HTTP composition. The claim
 * keeps `/api/astro-echo` Astro's (strict route ownership: inside the
 * claim the effect fetch is authoritative, outside it `site.fetch`
 * resolves `undefined` and Astro's pipeline serves). On workerd the
 * handler triple carries env + ctx, so request-scope finalizers ride
 * `ctx.waitUntil`.
 */
import { mount } from "alchemy/Serve";
import { FetchState, astro } from "astro/fetch";
import Site from "../site.ts";

const site = mount(Site, { routes: ["/api/*", "!/api/astro-echo"] });

export default {
  fetch: async (
    request: Request,
    env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> =>
    (await site.fetch(request, env, ctx)) ?? astro(new FetchState(request)),
};
