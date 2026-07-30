import * as Cloudflare from "alchemy/Cloudflare";
import { viewer } from "alchemy/Dashboard/Viewer";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { Config } from "effect";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
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
    const state = yield* makeHttpStateStore({
      id: "cloudflare-http",
      url: String(env.ALCHEMY_STATE_URL),
      authToken: String(env.ALCHEMY_STATE_TOKEN),
    });
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
