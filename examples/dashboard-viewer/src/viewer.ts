import * as Cloudflare from "alchemy/Cloudflare";
import { viewer } from "alchemy/Dashboard/Viewer";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { Config } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

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
      // Endpoint + bearer token of the deployed state store
      // (`~/.alchemy/credentials/{profile}/cloudflare-state-store` after any
      // deploy that used `Cloudflare.state()`).
      ALCHEMY_STATE_URL: Config.string("ALCHEMY_STATE_URL"),
      ALCHEMY_STATE_TOKEN: Config.redacted("ALCHEMY_STATE_TOKEN"),
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
    const env = yield* Cloudflare.Workers.WorkerEnvironment;

    // Deploy time: service-bind the state-store Worker. Cloudflare blocks
    // same-zone worker-to-worker `fetch` (error 1042, surfaced as a 404),
    // so when the viewer and `alchemy-state-store` share an account the
    // state API must ride a service binding. `ALCHEMY_STATE_SERVICE`
    // overrides the script name; set it to "" to skip the binding for
    // cross-zone deployments (custom domain on either side).
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const service = yield* Effect.sync(
        () => process.env.ALCHEMY_STATE_SERVICE ?? "alchemy-state-store",
      );
      if (service !== "") {
        const self = yield* Cloudflare.Workers.Worker;
        yield* self.bind`${self}`({
          bindings: [
            { type: "service", name: STATE_STORE_BINDING, service },
          ],
        });
      }
    }

    // Runtime: ride the service binding when it exists, else plain fetch.
    // The URL keeps addressing/auth identical in both modes — the binding
    // only replaces the transport.
    const stateStore = (env as Record<string, unknown>)[
      STATE_STORE_BINDING
    ] as { fetch: typeof globalThis.fetch } | undefined;
    const httpClient =
      stateStore === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
                stateStore.fetch(
                  input as never,
                  init as never,
                )) as typeof globalThis.fetch),
            ),
          );

    const state = yield* makeHttpStateStore({
      id: "cloudflare-http",
      url: String(env.ALCHEMY_STATE_URL),
      authToken: String(env.ALCHEMY_STATE_TOKEN),
    }).pipe(Effect.provide(httpClient));

    const handle = viewer({
      state,
      stack: String(env.ALCHEMY_VIEWER_STACK ?? "") || undefined,
      stage: String(env.ALCHEMY_VIEWER_STAGE ?? "") || undefined,
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
