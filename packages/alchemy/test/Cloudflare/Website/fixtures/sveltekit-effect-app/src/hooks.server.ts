/**
 * The mount (Serve/DESIGN.md) — kit's `handle` hook owns HTTP composition.
 * The claim keeps `/api/ping` kit's (strict route ownership: inside the
 * claim the effect fetch is authoritative, outside it `site.fetch`
 * resolves `undefined` and kit serves). On workerd `event.platform`
 * carries env + ctx so request-scope finalizers ride `ctx.waitUntil`; in
 * kit's dev server the platform proxy provides them the same way.
 *
 * Typed structurally (no `@sveltejs/kit` type import): the fixture ships
 * no `app.d.ts`, so kit's default empty `App.Platform` would reject the
 * `env`/`ctx` reads.
 */
import { mount } from "alchemy/Serve";
import Site from "./site.ts";

const site = mount(Site, { routes: ["/api/*", "!/api/ping"] });

export const handle = async ({
  event,
  resolve,
}: {
  event: {
    request: Request;
    platform?: {
      env?: unknown;
      ctx?: { waitUntil(promise: Promise<unknown>): void };
    };
  };
  resolve: (event: unknown) => Promise<Response>;
}): Promise<Response> =>
  (await site.fetch(
    event.request,
    event.platform?.env,
    event.platform?.ctx,
  )) ?? resolve(event);
