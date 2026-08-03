import * as Cloudflare from "alchemy/Cloudflare";
import { viewer } from "alchemy/Dashboard/Viewer";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { Config } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** `HttpClientRequest` body -> the `BodyInit` a Fetcher accepts. */
const toRequestBody = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<BodyInit | undefined, HttpClientError.HttpClientError> => {
  switch (request.body._tag) {
    case "Raw":
      return Effect.succeed(request.body.body as BodyInit);
    case "Uint8Array":
      return Effect.succeed(request.body.body as BodyInit);
    case "FormData":
      return Effect.succeed(request.body.formData);
    case "Stream":
      return Effect.mapError(
        Stream.toReadableStreamEffect(request.body.stream),
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.EncodeError({
              request,
              cause,
              description: "failed to encode stream body",
            }),
          }),
      );
    default:
      return Effect.succeed(undefined);
  }
};

/**
 * Hosted alchemy dashboard: the `@alchemy.run/dashboard` SPA served as
 * static assets, backed by the read-only viewer API reading a deployed
 * alchemy state store over HTTP.
 *
 * The assets directory resolves at DEPLOY time (the engine reads it from
 * the local filesystem); inside the deployed Worker the expression is
 * never used. Point `ALCHEMY_DASHBOARD_DIST` at a built dashboard `dist/`
 * to override the in-repo default.
 */
const dashboardDist =
  typeof process !== "undefined" && process.env !== undefined
    ? (process.env.ALCHEMY_DASHBOARD_DIST ?? "../../packages/dashboard/dist")
    : "";

/** The env key the state-store service binding is registered under. */
const STATE_STORE_BINDING = "ALCHEMY_STATE_STORE";

/**
 * Resolve the state store's endpoint + token at DEPLOY time:
 * `ALCHEMY_STATE_URL` / `ALCHEMY_STATE_TOKEN` env vars when set, else the
 * credentials `Cloudflare.state()` caches after any deploy at
 * `~/.alchemy/credentials/{profile}/cloudflare-state-store.json` — so a
 * plain `bun run deploy` targets the same store the CLI uses.
 */
const resolveStateCredentials = Effect.gen(function* () {
  const env = yield* Effect.sync(() => ({
    url: process.env.ALCHEMY_STATE_URL || undefined,
    token: process.env.ALCHEMY_STATE_TOKEN || undefined,
    profile: process.env.ALCHEMY_PROFILE || "default",
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
  }));
  if (env.url !== undefined && env.token !== undefined) {
    return { url: env.url, authToken: env.token };
  }
  const fs = yield* FileSystem.FileSystem;
  const file = `${env.home}/.alchemy/credentials/${env.profile}/cloudflare-state-store.json`;
  const cached = yield* fs.readFileString(file).pipe(
    Effect.flatMap((contents) =>
      Effect.try(
        () => JSON.parse(contents) as { url?: string; authToken?: string },
      ),
    ),
    Effect.orElseSucceed(() => undefined),
  );
  const url = env.url ?? cached?.url;
  const authToken = env.token ?? cached?.authToken;
  if (url === undefined || authToken === undefined) {
    return yield* Effect.die(
      new Error(
        "dashboard-viewer: no state store credentials found. Set " +
          "ALCHEMY_STATE_URL and ALCHEMY_STATE_TOKEN, or run any deploy " +
          `with Cloudflare.state() first so ${file} exists.`,
      ),
    );
  }
  return { url, authToken };
});

export default class Viewer extends Cloudflare.Worker<Viewer>()(
  "Viewer",
  {
    main: import.meta.url,
    assets: {
      directory: dashboardDist,
      // the SPA owns every non-API route; the API is always the Worker's
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      // Optional: pin the stack/stage the viewer opens with. Defaults to
      // the first stack/stage found in the store; `?stack=` / `?stage=`
      // select others per request.
      ALCHEMY_VIEWER_STACK: Config.string("ALCHEMY_VIEWER_STACK").pipe(
        Config.withDefault(""),
      ),
      ALCHEMY_VIEWER_STAGE: Config.string("ALCHEMY_VIEWER_STAGE").pipe(
        Config.withDefault(""),
      ),
    },
  },
  Effect.gen(function* () {
    // Deploy time: resolve the state store endpoint/token (env vars or
    // the profile's cached credentials) and register them on the Worker,
    // plus a service binding to the state-store Worker. Cloudflare
    // blocks same-zone worker-to-worker `fetch` (error 1042, surfaced
    // as a 404), so when the viewer and `alchemy-state-store` share an
    // account the state API must ride the binding. `ALCHEMY_STATE_SERVICE`
    // overrides the script name; set it to "" to skip the binding for
    // cross-zone deployments (custom domain on either side).
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const credentials = yield* resolveStateCredentials;
      const service = yield* Effect.sync(
        () => process.env.ALCHEMY_STATE_SERVICE ?? "alchemy-state-store",
      );
      const self = yield* Cloudflare.Workers.Worker;
      // The `/state-store` suffix keeps this bind's sid distinct from any
      // other self-bind on the worker (bindings dedupe by sid).
      yield* self.bind`${self}/state-store`({
        bindings: [
          { type: "plain_text", name: "ALCHEMY_STATE_URL", text: credentials.url },
          {
            type: "secret_text",
            name: "ALCHEMY_STATE_TOKEN",
            text: credentials.authToken,
          },
          ...(service !== ""
            ? [
                {
                  type: "service" as const,
                  name: STATE_STORE_BINDING,
                  service,
                },
              ]
            : []),
        ],
      });
    }

    const env = yield* Cloudflare.Workers.WorkerEnvironment;

    // Runtime: ride the service binding when it exists, else plain fetch.
    // The URL keeps addressing/auth identical in both modes — the binding
    // only replaces the transport.
    const stateStore = (env as Record<string, unknown>)[
      STATE_STORE_BINDING
    ] as { fetch: typeof globalThis.fetch } | undefined;
    // Build the client DIRECTLY on `binding.fetch` rather than swapping
    // `FetchHttpClient.Fetch` underneath the stock layer: the binding is
    // the whole point (Cloudflare blocks same-zone worker-to-worker global
    // fetch — 1042, surfaced as a 404), so the transport must not depend
    // on a context Reference resolving the way we expect inside workerd.
    const httpClient =
      stateStore === undefined
        ? FetchHttpClient.layer
        : Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request, url, signal) =>
              Effect.flatMap(
                toRequestBody(request),
                (body): Effect.Effect<
                  HttpClientResponse.HttpClientResponse,
                  HttpClientError.HttpClientError
                > =>
                  Effect.map(
                    Effect.tryPromise({
                      try: () =>
                        stateStore.fetch(url.toString(), {
                          method: request.method,
                          headers: request.headers as HeadersInit,
                          body,
                          signal,
                        }),
                      catch: (cause) =>
                        new HttpClientError.HttpClientError({
                          reason: new HttpClientError.TransportError({
                            request,
                            cause,
                            description: "state-store service binding fetch",
                          }),
                        }),
                    }),
                    (response) =>
                      HttpClientResponse.fromWeb(request, response),
                  ),
              ),
            ),
          );

    const stateUrl = String(env.ALCHEMY_STATE_URL ?? "");
    const state = yield* makeHttpStateStore({
      id: "cloudflare-http",
      url: stateUrl,
      authToken: String(env.ALCHEMY_STATE_TOKEN ?? ""),
    }).pipe(Effect.provide(httpClient));

    // Surfaced on `/api/health` so a broken deployment names itself:
    // `transport: "fetch"` when the service binding is missing (same-zone
    // worker-to-worker fetch is blocked by Cloudflare, so that config only
    // works cross-zone), `stateUrl: "(unset)"` when the URL binding never
    // attached. Host only — never the token.
    const diagnostics = {
      transport: stateStore === undefined ? "fetch" : "service-binding",
      stateUrl: (() => {
        if (stateUrl === "") return "(unset)";
        try {
          return new URL(stateUrl).host;
        } catch {
          return "(invalid)";
        }
      })(),
    };

    const handle = viewer({
      state,
      stack: String(env.ALCHEMY_VIEWER_STACK ?? "") || undefined,
      stage: String(env.ALCHEMY_VIEWER_STAGE ?? "") || undefined,
      diagnostics,
    });
    return {
      fetch: handle.pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }),
) {}
