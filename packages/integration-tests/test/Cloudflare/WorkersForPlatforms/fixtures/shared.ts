import * as Cloudflare from "@alchemy.run/cloudflare";
import * as pathe from "pathe";

/**
 * Dispatch namespace shared by the platform Worker (which binds it via `Get`)
 * and the user Worker (which is uploaded *into* it via the Worker `namespace`
 * prop). Deterministic, constant name per the test conventions.
 */
export const DispatchNs = Cloudflare.WorkersForPlatforms.DispatchNamespace("WfpBindingNs", {
  name: "alchemy-wfp-binding-test-ns",
});

/**
 * The values a dispatcher passes to the outbound Worker on each dispatch.
 * Cloudflare requires every declared value, so "no tenant" is `null`.
 */
export type OutboundParams = { tenant: string | null };

/**
 * The outbound values a platform Worker passes for a test request:
 * `?tenant=acme` passes `{ tenant: "acme" }` and no query passes
 * `{ tenant: null }`. `?probe=omit|undefined` leaves `tenant` out or sets it
 * to `undefined`, bypassing the type, to show that the platform refuses both.
 */
export const outboundValues = (query: URLSearchParams): OutboundParams => {
  switch (query.get("probe")) {
    case "omit":
      return {} as OutboundParams;
    case "undefined":
      return { tenant: undefined } as unknown as OutboundParams;
    default:
      return { tenant: query.get("tenant") };
  }
};

/**
 * The outbound Worker every `fetch()` from a user Worker dispatched through
 * {@link OutboundDispatch} goes through.
 */
export const OutboundWorker = Cloudflare.Worker("WfpOutboundWorker", {
  main: pathe.resolve(import.meta.dirname, "outbound-worker.ts"),
});

/** The stack that deploys {@link RefOutboundWorker}, apart from the test's own. */
export const OUTBOUND_REF_STACK = "WfpOutboundRefStack";

/**
 * An outbound Worker deployed by {@link OUTBOUND_REF_STACK}, which the
 * platform Worker reaches with `Cloudflare.Worker.ref`.
 */
export const RefOutboundWorker = Cloudflare.Worker("WfpRefOutboundWorker", {
  main: pathe.resolve(import.meta.dirname, "outbound-ref-worker.ts"),
});

/**
 * A second dispatch binding on {@link DispatchNs}, with an outbound Worker.
 * The same value is bound on the async platform Worker's `env` and yielded
 * by the Effect-native one.
 */
export const OutboundDispatch = Cloudflare.WorkersForPlatforms.Get<OutboundParams>(DispatchNs, {
  outbound: OutboundWorker,
  parameters: ["tenant"],
});

/**
 * Async (non-Effect) platform Worker that declares the dispatch namespace on
 * its `env`. `InferEnv` resolves `DISPATCH` to the native `cf.DispatchNamespace`
 * runtime binding, so the handler calls `env.DISPATCH.get(name)` directly — the
 * `env`-binding counterpart to the Effect-native `Get` platform worker.
 * `DISPATCH_OUTBOUND` binds the same namespace through an outbound Worker.
 */
export const AsyncPlatformWorker = Cloudflare.Worker("WfpAsyncPlatformWorker", {
  main: pathe.resolve(import.meta.dirname, "async-platform-handler.ts"),
  workersDev: true,
  env: {
    DISPATCH: DispatchNs,
    DISPATCH_OUTBOUND: OutboundDispatch,
  },
});

export type AsyncPlatformWorkerEnv = Cloudflare.InferEnv<typeof AsyncPlatformWorker>;

/**
 * Raw ESM source for a trivial "user worker" uploaded into {@link DispatchNs}.
 * Using the `script` form keeps it a plain module (no Effect runtime), which is
 * all we need to prove dynamic dispatch forwards the request: it echoes its
 * path and the `x-custom` header back as JSON so the test can assert the
 * platform Worker reached it. `/egress` fetches `https://example.com/probe`
 * and returns what came back, so the test can see whether an outbound Worker
 * intercepted the request.
 */
export const userWorkerScript = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/marked") {
      // The dev shim's own marks, set by a user Worker: platform code must
      // still see a plain success.
      return new Response("marked", {
        headers: { "x-alchemy-dispatch-error": "1", "x-alchemy-dispatch-shim": "1" },
      });
    }
    if (url.pathname === "/egress") {
      const res = await fetch("https://example.com/probe");
      return new Response(await res.text(), {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "text/plain" },
      });
    }
    return Response.json({
      handledBy: "user-worker",
      path: url.pathname,
      customHeader: request.headers.get("x-custom"),
      authorization: request.headers.get("authorization"),
    });
  },
};`;
