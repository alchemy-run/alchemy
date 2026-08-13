import type { APIContext } from "astro";

export const prerender = false;

/**
 * A REAL Astro endpoint carved out of the effect claim by the
 * `!/api/astro-echo` exclusion glob in `server.routes`: the path never
 * reaches the effect fetch — the generated fetchable wrapper hands it
 * straight to Astro's pipeline and this handler serves the response —
 * proof that exclusion globs route into framework routes, not just
 * static assets.
 */
export function GET({ url }: APIContext) {
  return Response.json({
    marker: "astro-endpoint-echo",
    path: url.pathname,
  });
}
