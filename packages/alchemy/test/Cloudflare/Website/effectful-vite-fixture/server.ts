/**
 * The mount (Serve/DESIGN.md) — the worker entry named by the site class's
 * `server: { entry: "./server.ts" }`. This SPA has no framework server, so
 * the fallthrough is the asset layer: `env.ASSETS.fetch` applies the
 * configured `notFoundHandling` (single-page-application ⇒ the shell). The
 * claim keeps `/api/excluded` out of the effect's ownership — the mount
 * declines it and the SPA shell serves.
 */
import { mount } from "alchemy/Serve";
import Site from "./site.ts";

const site = mount(Site, { routes: ["/api/*", "!/api/excluded"] });

interface AssetsEnv {
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

export default {
  fetch: async (
    request: Request,
    env: AssetsEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> =>
    (await site.fetch(request, env, ctx)) ??
    (env.ASSETS !== undefined
      ? env.ASSETS.fetch(request)
      : new Response("Not Found", { status: 404 })),
};
