import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

type Dispatch = (options: Record<string, unknown>, handler: unknown) => boolean;
interface Dispatcher {
  compose(interceptor: (dispatch: Dispatch) => Dispatch): Dispatcher;
}

/**
 * Node 26 bundles undici 8, whose `fetch` negotiates HTTP/2 by default and
 * funnels every concurrent request onto one session — which undici's
 * HTTP/2 path has been resetting under load. Wrap Node's own global
 * dispatcher (the npm `undici` package would mismatch the bundled major)
 * so each request carries `allowH2: false`. `undefined` on Bun, on older
 * Node, or if the slot can't be found — plain `fetch` as before.
 *
 * TODO: this is a stopgap copied from huggingface.js (#2495) and
 * OriginTrail/dkg (#2830). Revisit once undici's HTTP/2 path settles —
 * either drop it, or replace it with real request pacing driven by
 * Cloudflare's `ratelimit` headers so the engine stops relying on
 * transport quirks to avoid 429s.
 */
const resolveHttp1Dispatcher = async () => {
  if ("Bun" in globalThis || Number.parseInt(process.versions.undici ?? "0", 10) < 8) return;
  const slot = Symbol.for("undici.globalDispatcher.2");
  const lookup = () => (globalThis as Record<symbol, Dispatcher | undefined>)[slot];
  let base = lookup();
  if (base === undefined) {
    // undici creates the dispatcher lazily on first fetch; `data:` never hits the network.
    await fetch("data:,").catch(() => {});
    base = lookup();
  }
  return base?.compose(
    (dispatch) => (options, handler) => dispatch({ ...options, allowH2: false }, handler),
  );
};

/** The ambient `HttpClient`, forced onto HTTP/1.1 where `fetch` would negotiate HTTP/2. */
export const Http1FetchHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient;
    const dispatcher = yield* Effect.promise(resolveHttp1Dispatcher);
    if (dispatcher === undefined) return base;
    return HttpClient.transform(base, (effect) =>
      Effect.provideService(effect, FetchHttpClient.RequestInit, { dispatcher } as RequestInit),
    );
  }),
);
