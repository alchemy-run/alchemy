import * as http from "node:http";
import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Service } from "../../bindings/index.ts";
import * as RemoteBindings from "../../remote-bindings/RemoteBindings.ts";
import * as RemoteWorker from "../../remote-bindings/RemoteWorker.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

/**
 * Regression spec for stale preview sessions (reported as "alchemy dev stops
 * handling requests after a while / after machine sleep; D1 returns error
 * 1031, R2 returns Unspecified error (0), until the process is restarted").
 *
 * The `RemoteBindingProxy` durable object caches the preview session config
 * (`{ url, headers }` incl. `cf-workers-preview-token`) it obtains from
 * `RemoteWorker.deploy` and reuses it for every proxied binding call. Preview
 * tokens expire after ~1 hour, and an expired/invalidated session surfaces in
 * (at least) two shapes at the edge:
 *
 *  1. HTTP 400 with an HTML body containing "Invalid Workers Preview
 *     configuration" — the classic expired-preview-token page.
 *  2. HTTP 400 with a text/plain body containing "error code: 1031" —
 *     returned by remote bindings (D1, R2, Workers AI, ...) when their
 *     underlying session has timed out. (See workers-sdk's ProxyWorker
 *     `checkForPreviewTokenError`, wrangler PR #13016.)
 *
 * The proxy must invalidate its cached config and retry for BOTH signals,
 * and concurrent stale requests must share ONE refresh instead of each
 * minting a new preview session. This spec fakes the edge with a local HTTP
 * server whose first deployed "session" is expired, so no Cloudflare account
 * is needed and the expiry is deterministic.
 */

interface EdgeState {
  /** number of times RemoteWorker.deploy was invoked (i.e. preview sessions created) */
  deployCount: number;
  /** base URL of the fake edge server; set by each test before starting a worker */
  edgeUrl: string;
  /** response the fake edge sends while the session generation is 1 (the stale session) */
  staleResponse: { status: number; body: string; headers?: Record<string, string> };
  /** response the fake edge sends for every session generation, when set */
  edgeResponse?: { status: number; body: string; headers: Record<string, string> };
}

const state: EdgeState = {
  deployCount: 0,
  edgeUrl: "",
  staleResponse: { status: 400, body: "" },
};

const resetState = (staleResponse: EdgeState["staleResponse"]) =>
  Effect.sync(() => {
    state.deployCount = 0;
    state.edgeUrl = "";
    state.staleResponse = staleResponse;
    state.edgeResponse = undefined;
  });

/**
 * Stand-in for the real `RemoteWorker` (which would create a Cloudflare
 * preview session + upload the proxy script). Each `deploy` mints a new
 * "session" identified by a generation header, mirroring how each real
 * deploy mints a fresh `cf-workers-preview-token`.
 */
const StubRemoteWorker = Layer.succeed(
  RemoteWorker.RemoteWorker,
  RemoteWorker.RemoteWorker.of({
    deploy: () =>
      Effect.sync(() => {
        state.deployCount++;
        return {
          url: state.edgeUrl,
          headers: { "x-preview-generation": String(state.deployCount) },
        };
      }),
  }),
);

/**
 * Fake workers.dev edge: session generation 1 is expired (answers every
 * request with the configured stale-session error), generation >= 2 is
 * healthy.
 */
const startFakeEdge = Effect.acquireRelease(
  Effect.callback<http.Server>((resume) => {
    const server = http.createServer((req, res) => {
      const generation = req.headers["x-preview-generation"];
      if (state.edgeResponse) {
        res.writeHead(state.edgeResponse.status, state.edgeResponse.headers);
        res.end(state.edgeResponse.body);
      } else if (generation === "1") {
        res.writeHead(state.staleResponse.status, {
          "content-type": "text/plain",
        });
        res.end(state.staleResponse.body);
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`ok:${String(generation)}`);
      }
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.callback<void>((resume) => server.close(() => resume(Effect.void))),
).pipe(
  Effect.tap((server) =>
    Effect.sync(() => {
      const address = server.address() as { port: number };
      state.edgeUrl = `http://127.0.0.1:${address.port}`;
    }),
  ),
);

const WORKER_SCRIPT = `
export default {
  async fetch(request, env) {
    const upstream = await env.SVC.fetch("http://example.com/ping");
    return new Response(await upstream.text(), { status: upstream.status });
  }
};
`;

const startWorkerWithRemoteBinding = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate: "2026-03-10",
    compatibilityFlags: [],
    bindings: [Service.remote("SVC", "some-deployed-worker")],
    modules: [{ name: "main.js", type: "ESModule", content: WORKER_SCRIPT }],
  });

const fetchBody = (worker: { fetch: (path: string) => Effect.Effect<Response> }) =>
  worker.fetch("/").pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => ({
        status: response.status,
        body: await response.text(),
      })),
    ),
  );

const testLayer = RemoteBindings.RemoteBindingsLive.pipe(
  Layer.provide(StubRemoteWorker),
  Layer.provideMerge(localRuntimeLayer),
);

layer(testLayer, { excludeTestServices: true })("RemoteBindings stale session", (it) => {
  it.effect(
    "recovers when the edge returns 400 'Invalid Workers Preview configuration'",
    () =>
      Effect.gen(function* () {
        yield* resetState({
          status: 400,
          body: "<html>Invalid Workers Preview configuration</html>",
        });
        yield* startFakeEdge;
        const worker = yield* startWorkerWithRemoteBinding("stale-invalid-preview-config");

        // The cached session (generation 1) is expired. The proxy must
        // create a fresh session and retry, so the caller never sees the
        // stale-session error.
        const first = yield* fetchBody(worker);
        expect(first.body).toMatch(/^ok:/);
        expect(first.status).toBe(200);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "recovers when the edge returns 'error code: 1031' (D1/R2/AI session timeout)",
    () =>
      Effect.gen(function* () {
        yield* resetState({ status: 400, body: "error code: 1031" });
        yield* startFakeEdge;
        const worker = yield* startWorkerWithRemoteBinding("stale-error-code-1031");

        const first = yield* fetchBody(worker);
        expect(first.body).toMatch(/^ok:/);
        expect(first.status).toBe(200);

        // Recovery must not degrade into deploy-per-request: the refreshed
        // session is cached and reused.
        const settled = state.deployCount;
        const second = yield* fetchBody(worker);
        expect(second.body).toMatch(/^ok:/);
        expect(state.deployCount).toBe(settled);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "concurrent requests against an expired session share a single refresh",
    () =>
      Effect.gen(function* () {
        yield* resetState({
          status: 400,
          body: "<html>Invalid Workers Preview configuration</html>",
        });
        yield* startFakeEdge;
        const worker = yield* startWorkerWithRemoteBinding("stale-single-flight");

        const [first, second] = yield* Effect.all([fetchBody(worker), fetchBody(worker)], {
          concurrency: "unbounded",
        });
        expect(first.body).toMatch(/^ok:/);
        expect(second.body).toMatch(/^ok:/);

        // The prefetched session (deploy #1) expired; recovering from that
        // must cost exactly one more deploy no matter how many requests were
        // in flight when it was detected.
        expect(state.deployCount).toBe(2);
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  const ACCESS_LOGIN_URL =
    "https://team.cloudflareaccess.com/cdn-cgi/access/login/worker.example.workers.dev?meta=secret-jwt";

  it.effect(
    "reports an Access login redirect instead of following it",
    () =>
      Effect.gen(function* () {
        yield* resetState({ status: 400, body: "" });
        state.edgeResponse = {
          status: 302,
          body: "",
          headers: { location: ACCESS_LOGIN_URL, "set-cookie": "CF_AppSession=abc" },
        };
        yield* startFakeEdge;
        const worker = yield* startWorkerWithRemoteBinding("access-login-redirect");

        const result = yield* fetchBody(worker);
        expect(result.status).toBe(401);
        expect(result.body).toContain("redirected this remote bindings request to its login page");
        expect(result.body).toContain('binding "SVC"');
        expect(result.body).not.toContain("secret-jwt");
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "reports a 403 Access block page",
    () =>
      Effect.gen(function* () {
        yield* resetState({ status: 400, body: "" });
        state.edgeResponse = {
          status: 403,
          body: "<html><title>Error ・ Cloudflare Access</title></html>",
          headers: { "content-type": "text/html" },
        };
        yield* startFakeEdge;
        const worker = yield* startWorkerWithRemoteBinding("access-blocked");

        const result = yield* fetchBody(worker);
        expect(result.status).toBe(403);
        expect(result.body).toContain("Cloudflare Access blocked this remote bindings request");
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  it.effect(
    "passes through Access-like responses the remote worker forwarded from the binding",
    () =>
      Effect.gen(function* () {
        yield* resetState({ status: 400, body: "" });
        state.edgeResponse = {
          status: 403,
          body: "the binding's own Cloudflare Access page",
          headers: { "content-type": "text/plain", "mf-forwarded-response": "true" },
        };
        yield* startFakeEdge;
        const worker = yield* startWorkerWithRemoteBinding("access-forwarded");

        const response = yield* worker.fetch("/");
        expect(response.status).toBe(403);
        expect(response.headers.has("mf-forwarded-response")).toBe(false);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "the binding's own Cloudflare Access page",
        );
      }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );
});
