import * as Output from "alchemy/Output";
import { defaultProviderMode, remote, type ProviderMode } from "alchemy/ProviderMode";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Worker } from "../../Workers/Worker.ts";
import type { DispatchNamespace } from "../DispatchNamespace.ts";
import { Get } from "../Get.ts";
import { outboundBindingName, type ResolvedOutbound } from "./outbound.ts";

/**
 * Dev-mode shim for a dispatch binding with an outbound Worker.
 *
 * In `alchemy dev` a dispatch namespace has no local emulation, so a local
 * Worker's dispatch binding goes through the remote-bindings preview proxy.
 * Cloudflare's preview refuses a `dispatch_namespace` binding that has an
 * `outbound` Worker ("The specified dispatch namespace does not exist on this
 * account"), while a regular upload accepts it. So, as for queues (see
 * `Queues/QueueShim.ts`), alchemy deploys a REAL shim Worker that holds the
 * binding with its outbound Worker, and the local binding forwards to it:
 *
 *   local worker ── env.NS.get(name, args, { outbound }).fetch(req)
 *        │  MF-Dispatch-Namespace-Options: { name, args, options }
 *        ▼
 *   forwarder service (local workerd) ── + x-alchemy-dispatch-token: <token>
 *        ▼
 *   deployed shim (workers.dev) ── env.DISPATCH.get(name, args, options).fetch(req)
 *        ▼
 *   user Worker in the namespace, its egress through the outbound Worker
 *
 * Only `fetch` crosses: `args` and `options` travel as JSON, so an RPC stub
 * in them, or an RPC call on the dispatched Worker, can't. The shim and its
 * token are engine-managed resources registered at eval time only when a
 * LOCAL Worker binds the namespace with a LIVE outbound Worker (one piped
 * through `Alchemy.remote()`, or a `Worker.ref` to another stack's), deleted
 * on destroy and collected once the stack deploys for real. A local outbound
 * Worker exists only on this machine, where neither the shim nor Cloudflare
 * can call it, so it gets no shim, and the binding warns at eval that its
 * dispatches can't reach the namespace until the outbound Worker is
 * `Alchemy.remote()`.
 *
 * NOT exported from `index.ts`: binding-internal scaffolding.
 */
const DISPATCH_SHIM_SCRIPT = `const SHIM_HEADER = "x-alchemy-dispatch-shim";
const ERROR_HEADER = "x-alchemy-dispatch-error";
const OPTIONS_HEADER = "MF-Dispatch-Namespace-Options";
const URL_HEADER = "x-alchemy-dispatch-url";
// The shim's own credential: the request's Authorization reaches the user Worker.
const TOKEN_HEADER = "x-alchemy-dispatch-token";

// Every answer from the shim is marked, so the local forwarder can tell it
// from the workers.dev URL not serving yet. A user Worker's own marks are
// dropped first: only the shim says a dispatch failed.
function marked(response, error) {
  const answer = new Response(response.body, response);
  answer.headers.delete(ERROR_HEADER);
  answer.headers.set(SHIM_HEADER, "1");
  if (error) answer.headers.set(ERROR_HEADER, "1");
  return answer;
}

export default {
  async fetch(request, env) {
    if (request.headers.get(TOKEN_HEADER) !== env.SHIM_TOKEN) {
      return marked(new Response("unauthorized", { status: 401 }), true);
    }
    const metadata = request.headers.get(OPTIONS_HEADER);
    if (metadata === null) {
      return marked(new Response("missing " + OPTIONS_HEADER, { status: 400 }), true);
    }
    const url = request.headers.get(URL_HEADER) ?? request.url;
    const headers = new Headers(request.headers);
    for (const header of [TOKEN_HEADER, OPTIONS_HEADER, URL_HEADER]) headers.delete(header);
    try {
      const { name, args, options } = JSON.parse(metadata);
      const worker = env.DISPATCH.get(name, args, options);
      return marked(
        await worker.fetch(
          new Request(url, { method: request.method, headers, body: request.body, redirect: "manual" }),
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return marked(new Response(message, { status: 500 }), true);
    }
  },
};`;

export interface DispatchShimBinding {
  url: Output.Output<string | undefined>;
  token: Output.Output<Redacted.Redacted<string>>;
}

/**
 * Register the dispatch shim for a binding with an outbound Worker when the
 * host Worker runs locally and the outbound Worker is live (a dev run), and
 * return its outputs for the binding data. Any other case returns
 * `undefined`, including the shim's own binding: the shim is pinned live, so
 * there is no recursion. A local host with a local outbound Worker gets a
 * warning: its dispatches can't reach the namespace, and `Alchemy.remote()`
 * on the outbound Worker is the remedy.
 */
export const maybeDispatchShim = Effect.fn(function* (
  namespace: DispatchNamespace,
  outbound: ResolvedOutbound,
  host: { Mode?: ProviderMode | undefined },
) {
  const runDefault = yield* defaultProviderMode;
  const hostMode = host.Mode ?? runDefault;
  // A ref names a Worker another stack deploys, so it is live.
  const outboundMode = Output.isRefExpr(outbound.worker)
    ? "live"
    : (outbound.worker.Mode ?? runDefault);
  if (hostMode !== "local") return undefined;
  if (outboundMode !== "live") {
    yield* Effect.logWarning(
      `Dispatch namespace "${namespace.LogicalId}" is bound with outbound Worker "${outbound.worker.LogicalId}", which runs locally in this dev run, where Cloudflare can't call it: no dispatch through this binding reaches the namespace, because Cloudflare's preview refuses the binding ("The specified dispatch namespace does not exist on this account"). Pipe "${outbound.worker.LogicalId}" through Alchemy.remote() to dispatch with it in alchemy dev.`,
    );
    return undefined;
  }
  const id = `${outboundBindingName(namespace, outbound)}Shim`;
  const token = yield* Random(`${id}Token`);
  const shim = yield* Worker(id, {
    script: DISPATCH_SHIM_SCRIPT,
    env: {
      DISPATCH: Get<Record<string, unknown>>(namespace, {
        outbound: outbound.worker,
        parameters: outbound.parameters,
      }),
      SHIM_TOKEN: token.text,
    },
  }).pipe(remote());
  return { url: shim.url, token: token.text } satisfies DispatchShimBinding;
});
