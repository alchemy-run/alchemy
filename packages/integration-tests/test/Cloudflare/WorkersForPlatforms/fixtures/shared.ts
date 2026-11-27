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
 * The outbound Worker every `fetch()` from a user Worker dispatched through
 * {@link OutboundDispatch} goes to.
 */
export const OutboundWorker = Cloudflare.Worker("WfpOutboundWorker", {
  main: pathe.resolve(import.meta.dirname, "outbound-worker.ts"),
  env: { VIA: "stack" },
});

/** The stack that deploys {@link RefOutboundWorker}, apart from the test's own. */
export const OUTBOUND_REF_STACK = "WfpOutboundRefStack";

/**
 * An outbound Worker {@link OUTBOUND_REF_STACK} deploys, which the platform
 * Worker reaches with `Cloudflare.Worker.ref`.
 */
export const RefOutboundWorker = Cloudflare.Worker("WfpRefOutboundWorker", {
  main: pathe.resolve(import.meta.dirname, "outbound-worker.ts"),
  env: { VIA: "ref" },
});

/**
 * A second dispatch binding on {@link DispatchNs}, with an outbound Worker:
 * bound on the async platform Worker's `env` and yielded by the Effect-native
 * one.
 */
export const OutboundDispatch = Cloudflare.WorkersForPlatforms.Get(DispatchNs, {
  outbound: OutboundWorker,
  parameters: ["tenant"],
});

/**
 * Async (non-Effect) platform Worker that declares the dispatch namespace on
 * its `env`. `InferEnv` resolves `DISPATCH` to the native `cf.DispatchNamespace`
 * runtime binding, so the handler calls `env.DISPATCH.get(name)` directly — the
 * `env`-binding counterpart to the Effect-native `Get` platform worker.
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
 * answered it.
 */
export const userWorkerScript = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/egress") return fetch("https://example.com/probe");
    return Response.json({
      handledBy: "user-worker",
      path: url.pathname,
      customHeader: request.headers.get("x-custom"),
    });
  },
};`;
