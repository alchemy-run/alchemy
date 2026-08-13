import { json } from "@sveltejs/kit";

/**
 * A KIT endpoint INSIDE the Effect fetch's `/api/*` route space: the
 * effect program passes requests it does not own through to kit (the
 * `RouteNotFound` passthrough protocol), so this route must keep working —
 * proof of the passthrough protocol end to end, in dev (the effect dev
 * middleware falls through to kit's Vite dev server) and deployed (the
 * generated Lambda entry falls through to kit's `respond`).
 */
export const GET = ({ url }: { url: URL }) =>
  json({
    marker: "SVELTEKIT_AWS_EFFECT_KIT_API",
    via: "kit",
    echo: url.searchParams.get("echo"),
  });
