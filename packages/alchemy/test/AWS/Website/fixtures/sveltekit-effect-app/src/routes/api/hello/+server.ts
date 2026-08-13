import { json } from "@sveltejs/kit";

/**
 * A KIT endpoint carved out of the Effect fetch's `/api/*` claim by the
 * `!/api/hello` exclusion glob in `server.routes`: the path never reaches
 * the effect fetch, so this route must keep working — proof of strict
 * route ownership's exclusion globs end to end, in dev (the effect dev
 * middleware declines the path and kit's Vite dev server serves it) and
 * deployed (the generated Lambda entry hands it to kit's `respond`).
 */
export const GET = ({ url }: { url: URL }) =>
  json({
    marker: "SVELTEKIT_AWS_EFFECT_KIT_API",
    via: "kit",
    echo: url.searchParams.get("echo"),
  });
