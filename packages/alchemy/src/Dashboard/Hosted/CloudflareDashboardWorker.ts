import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  Worker,
  WorkerEnvironment,
  type WorkerDomainConfig,
} from "../../Cloudflare/Workers/Worker.ts";
import type { WorkerAccessConfig } from "../../Cloudflare/Workers/WorkerAccess.ts";
import { makeHttpStateStore } from "../../State/HttpStateStore.ts";
import { viewer } from "../Viewer.ts";

/**
 * The Cloudflare Worker behind `Dashboard.Hosted.Cloudflare`: the
 * `@alchemy.run/dashboard` SPA served as static assets, backed by the
 * read-only {@link viewer} API reading a deployed alchemy state store over
 * its HTTP API.
 *
 * This module is the Worker's bundle entry (`main: import.meta.url`), so it
 * stays lean: everything deploy-time — resolving the SPA directory and the
 * state store's credentials — happens in the stack-side factory
 * (`Hosted/Cloudflare.ts`) and reaches this class through
 * {@link CloudflareDashboardOptions} (Worker props) and the ambient
 * `ConfigProvider` (the `Config` reads below, which the deploy-time
 * interceptor lowers into secret bindings).
 *
 * Users never import this file directly; `Dashboard.Hosted.Cloudflare`
 * yields it.
 */

/** The env key the state-store service binding is registered under. */
export const STATE_STORE_BINDING = "ALCHEMY_STATE_STORE";

/** `Config` keys the Worker reads (bound into its env at deploy time). */
export const STATE_URL_KEY = "ALCHEMY_STATE_URL";
export const STATE_TOKEN_KEY = "ALCHEMY_STATE_TOKEN";
export const DASHBOARD_STACK_KEY = "ALCHEMY_DASHBOARD_STACK";
export const DASHBOARD_STAGE_KEY = "ALCHEMY_DASHBOARD_STAGE";

/**
 * Deploy-time knobs the factory hands the Worker class. A `Reference` (not
 * a required service): the class evaluates its props at runtime too, where
 * nothing is provided and the defaults apply.
 */
export interface CloudflareDashboardOptionsShape {
  /** Directory of the built SPA to upload as the Worker's assets. */
  readonly assets?: string;
  /** Cloudflare Access policies gating the dashboard. */
  readonly access?: WorkerAccessConfig;
  /** Custom domain for the dashboard. */
  readonly domain?: string | WorkerDomainConfig;
  /**
   * Script name of the state-store Worker to bind as a service binding;
   * `undefined` skips the binding and the state client uses plain fetch.
   */
  readonly stateService?: string;
}

export const CloudflareDashboardOptions =
  Context.Reference<CloudflareDashboardOptionsShape>(
    "alchemy/Dashboard/Hosted/CloudflareDashboardOptions",
    { defaultValue: () => ({}) },
  );

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
 * An `HttpClient` riding a service binding's `fetch`. Built DIRECTLY on
 * the binding rather than swapping `FetchHttpClient.Fetch` underneath the
 * stock layer: the binding is the whole point (Cloudflare blocks same-zone
 * worker-to-worker global fetch — error 1042, surfaced as a 404), so the
 * transport must not depend on a context Reference resolving the way we
 * expect inside workerd.
 */
const serviceBindingClient = (binding: { fetch: typeof globalThis.fetch }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url, signal) =>
      Effect.flatMap(
        toRequestBody(request),
        (
          body,
        ): Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError
        > =>
          Effect.map(
            Effect.tryPromise({
              try: () =>
                binding.fetch(url.toString(), {
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
            (response) => HttpClientResponse.fromWeb(request, response),
          ),
      ),
    ),
  );

interface RuntimeConfig {
  readonly stateUrl: string;
  readonly stateToken: Redacted.Redacted<string>;
  readonly stack: string | undefined;
  readonly stage: string | undefined;
}

/**
 * Build the viewer handler for one isolate's env. The state client is
 * cheap (an in-memory `HttpApiClient` over `fetch`) and holds no
 * disposable resource, so it is safe to keep for the isolate's lifetime.
 */
const makeHandler = (env: Record<string, unknown>, config: RuntimeConfig) =>
  Effect.gen(function* () {
    // Ride the service binding when it exists, else plain fetch. The URL
    // keeps addressing/auth identical in both modes — the binding only
    // replaces the transport.
    const stateStore = env[STATE_STORE_BINDING] as
      | { fetch: typeof globalThis.fetch }
      | undefined;
    const httpClient =
      stateStore === undefined
        ? FetchHttpClient.layer
        : serviceBindingClient(stateStore);
    const state = yield* makeHttpStateStore({
      id: "cloudflare-http",
      url: config.stateUrl,
      authToken: Redacted.value(config.stateToken),
    }).pipe(Effect.provide(httpClient));

    // Surfaced on `/api/health` so a broken deployment names itself:
    // `transport: "fetch"` when the service binding is missing (same-zone
    // worker-to-worker fetch is blocked by Cloudflare, so that config
    // only works cross-zone), `stateUrl: "(unset)"` when the URL binding
    // never attached. Host only — never the token.
    let stateHost: string;
    if (config.stateUrl === "") {
      stateHost = "(unset)";
    } else {
      stateHost = yield* Effect.try(() => new URL(config.stateUrl).host).pipe(
        Effect.orElseSucceed(() => "(invalid)"),
      );
    }
    const handle = viewer({
      state,
      stack: config.stack,
      stage: config.stage,
      diagnostics: {
        transport: stateStore === undefined ? "fetch" : "service-binding",
        stateUrl: stateHost,
      },
    });
    return handle.pipe(
      Effect.catchCause((cause) =>
        HttpServerResponse.json(
          { error: Cause.pretty(cause) },
          { status: 500 },
        ),
      ),
    ) as Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest
    >;
  });

export default class CloudflareDashboard extends Worker<CloudflareDashboard>()(
  "AlchemyDashboard",
  Effect.map(CloudflareDashboardOptions, (options) => ({
    main: import.meta.url,
    ...(options.assets !== undefined
      ? {
          assets: {
            directory: options.assets,
            // the SPA owns every non-API route; the API is always the Worker's
            notFoundHandling: "single-page-application" as const,
            runWorkerFirst: ["/api/*"],
          },
        }
      : {}),
    ...(options.access !== undefined ? { access: options.access } : {}),
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
  })),
  Effect.gen(function* () {
    // Deploy time: the factory's ConfigProvider overlay answers these and
    // the Config interceptor lowers each read into a secret binding.
    // Runtime: the same reads resolve from the Worker's env.
    const stateUrl = yield* Config.string(STATE_URL_KEY).pipe(
      Config.withDefault(""),
    );
    const stateToken = yield* Config.redacted(STATE_TOKEN_KEY).pipe(
      Config.withDefault(Redacted.make("")),
    );
    const stack = yield* Config.string(DASHBOARD_STACK_KEY).pipe(
      Config.withDefault(""),
    );
    const stage = yield* Config.string(DASHBOARD_STAGE_KEY).pipe(
      Config.withDefault(""),
    );
    const config: RuntimeConfig = {
      stateUrl,
      stateToken,
      stack: stack === "" ? undefined : stack,
      stage: stage === "" ? undefined : stage,
    };

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // Cloudflare blocks same-zone worker-to-worker `fetch` (error 1042,
      // surfaced as a 404), so when the dashboard and the state-store
      // Worker share an account the state API must ride a service
      // binding. The factory names the script (or leaves it undefined for
      // cross-zone deployments, where plain fetch works).
      const { stateService } = yield* CloudflareDashboardOptions;
      if (stateService !== undefined) {
        const self = yield* Worker;
        // The `/state-store` suffix keeps this bind's sid distinct from
        // any other self-bind on the worker (bindings dedupe by sid).
        yield* self.bind`${self}/state-store`({
          bindings: [
            {
              type: "service",
              name: STATE_STORE_BINDING,
              service: stateService,
            },
          ],
        });
      }
    }

    // One handler per isolate env: `WorkerEnvironment` only exists at
    // exec phase, so the client is built lazily on the first request and
    // reused — the env object is stable for the isolate's lifetime.
    const handlers = new WeakMap<
      object,
      Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        never,
        HttpServerRequest
      >
    >();
    return {
      fetch: Effect.gen(function* () {
        const env = yield* WorkerEnvironment;
        let handle = handlers.get(env);
        if (handle === undefined) {
          handle = yield* makeHandler(env, config);
          handlers.set(env, handle);
        }
        return yield* handle;
      }),
    };
  }),
) {}
