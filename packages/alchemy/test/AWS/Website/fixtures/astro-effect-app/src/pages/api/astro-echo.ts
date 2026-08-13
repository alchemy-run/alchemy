import type { APIContext } from "astro";

export const prerender = false;

/**
 * A REAL Astro endpoint inside the effect scope (`/api/*`): the effect
 * fetch declines it (typed `RouteNotFound` passthrough), the generated
 * fetchable wrapper falls back to Astro's pipeline, and this handler
 * serves the response — proof that passthrough delegates into framework
 * routes, not just static assets.
 */
export function GET({ url }: APIContext) {
  return Response.json({
    marker: "astro-endpoint-echo",
    path: url.pathname,
  });
}
