import type { APIContext } from "astro";

export const prerender = false;

/**
 * A REAL Astro endpoint carved out of the effect claim by the
 * `!/api/astro-echo` exclusion glob in `server.routes`: the generated
 * fetchable wrapper never dispatches the effect fetch for it, Astro's
 * pipeline serves it — proof that exclusion globs delegate into framework
 * routes, not just static assets.
 */
export function GET({ url }: APIContext) {
  return Response.json({
    marker: "astro-endpoint-echo",
    path: url.pathname,
  });
}
