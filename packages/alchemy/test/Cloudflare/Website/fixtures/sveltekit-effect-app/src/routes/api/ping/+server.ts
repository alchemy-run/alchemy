import { json } from "@sveltejs/kit";

// Local Platform shape — see ../../+page.server.ts.
interface Platform {
  env?: { TEST_BINDING?: string };
}

/**
 * A KIT endpoint INSIDE the Effect fetch's `/api/*` route space: the
 * effect program passes requests it does not own through to kit
 * (`Serve.passthrough`), so this route must keep working — proof of the
 * passthrough protocol end to end.
 */
export const GET = ({ platform }: { platform?: Platform }) =>
  json({
    server: true,
    via: "kit",
    binding: platform?.env?.TEST_BINDING ?? null,
  });
