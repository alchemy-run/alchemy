import * as Cloudflare from "@/Cloudflare/index.ts";

/**
 * Dispatch namespace shared by the platform Worker (which binds it via `Get`)
 * and the user Worker (which is uploaded *into* it via the Worker `namespace`
 * prop). Deterministic, constant name per the test conventions.
 */
export const DispatchNs = Cloudflare.WorkersForPlatforms.DispatchNamespace(
  "WfpBindingNs",
  { name: "alchemy-wfp-binding-test-ns" },
);

/**
 * Raw ESM source for a trivial "user worker" uploaded into {@link DispatchNs}.
 * Using the `script` form keeps it a plain module (no Effect runtime), which is
 * all we need to prove dynamic dispatch forwards the request: it echoes its
 * path and the `x-custom` header back as JSON so the test can assert the
 * platform Worker reached it.
 */
export const userWorkerScript = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      handledBy: "user-worker",
      path: url.pathname,
      customHeader: request.headers.get("x-custom"),
    });
  },
};`;
