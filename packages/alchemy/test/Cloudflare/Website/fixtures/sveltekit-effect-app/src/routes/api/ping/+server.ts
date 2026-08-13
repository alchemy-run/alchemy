import { json } from "@sveltejs/kit";

// Local Platform shape — see ../../+page.server.ts.
interface Platform {
  env?: { TEST_BINDING?: string };
}

/**
 * A KIT endpoint carved OUT of the Effect fetch's `/api/*` claim by the
 * `!/api/ping` exclusion glob in `server.routes`: the framework serves it
 * without the effect fetch ever running — proof of strict route
 * ownership's static delegation end to end.
 */
export const GET = ({ platform }: { platform?: Platform }) =>
  json({
    server: true,
    via: "kit",
    binding: platform?.env?.TEST_BINDING ?? null,
  });
