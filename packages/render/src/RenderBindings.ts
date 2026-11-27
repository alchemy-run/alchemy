import {
  Credentials,
  CredentialsFromEnv,
  fromApiKey,
  type RenderOpContext,
} from "@distilled.cloud/render";
import { orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Output from "alchemy/Output";
import type { Resource } from "alchemy/Resource";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { SecretString } from "./Types.ts";

/**
 * Binding contract accepted by Render compute services (`WebService`,
 * `PrivateService`, `BackgroundWorker`, `CronJob`, `StaticSite`, `ServicePreview`).
 */
export interface RenderServiceBinding {
  /** Environment variables injected onto the Render service during reconcile. */
  env?: Record<string, SecretString>;
}

/**
 * Env vars holding the Render API key and base URL when a binding needs
 * Render API access inside a host runtime (`RunWorkflowTask`).
 */
export const TOKEN_ENV = {
  apiKey: "RENDER_API_KEY",
  apiBaseUrl: "RENDER_API_BASE_URL",
} as const;

/** What a Render binding attaches to its host. */
export interface HostBinding {
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
  /** When true, binds the Render API credentials into the host's runtime context. */
  readonly apiAccess?: boolean;
}

/** The signature {@link Bind} yields. */
export type BindHost = (
  label: TemplateStringsArray,
  ...args: unknown[]
) => (data?: HostBinding) => Effect.Effect<void>;

/**
 * Bind environment variables (and optionally Render API credentials) onto the
 * current host via `CurrentRuntimeContext` during deploy.
 *
 * Returns a no-op inside host runtime bundles (`globalThis.__ALCHEMY_RUNTIME__`)
 * and when running outside a host (scripts / deploy-time Actions).
 */
export const Bind: Effect.Effect<BindHost> = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return () => () => Effect.void;
  const ambient = yield* Effect.serviceOption(Credentials);
  return (_label: TemplateStringsArray, ..._args: unknown[]) =>
    Effect.fn(function* (data: HostBinding = {}) {
      const runtime = yield* CurrentRuntimeContext;
      if (runtime === undefined) return;

      if (data.apiAccess) {
        const resolve = Option.isSome(ambient)
          ? ambient.value
          : yield* Credentials.pipe(
              Effect.provide(CredentialsFromEnv),
              orDieCredentialsUnavailable("Render"),
            );
        const creds = yield* resolve.pipe(orDieCredentialsUnavailable("Render"));
        yield* runtime.set(TOKEN_ENV.apiKey, Output.literal(creds.apiKey));
        yield* runtime.set(TOKEN_ENV.apiBaseUrl, Output.literal(creds.apiBaseUrl));
      }

      for (const [name, value] of Object.entries(data.env ?? {})) {
        yield* runtime.set(name, Output.isOutput(value) ? value : Output.literal(value));
      }
    });
});

const operationContext = Effect.gen(function* () {
  const runtime = yield* CurrentRuntimeContext;
  if (globalThis.__ALCHEMY_RUNTIME__ && runtime !== undefined) {
    const apiKey = yield* runtime.get<string | Redacted.Redacted<string>>(TOKEN_ENV.apiKey);
    if (apiKey !== undefined) {
      const redactedKey = Redacted.isRedacted(apiKey) ? apiKey : Redacted.make(apiKey);
      if (Redacted.value(redactedKey).length > 0) {
        const apiBaseUrl = yield* runtime.get<string>(TOKEN_ENV.apiBaseUrl);
        return yield* Layer.build(
          Layer.mergeAll(
            fromApiKey({
              apiKey: redactedKey,
              ...(typeof apiBaseUrl === "string" && apiBaseUrl.length > 0 ? { apiBaseUrl } : {}),
            }),
            FetchHttpClient.layer,
          ),
        ).pipe(Effect.scoped);
      }
    }
  }

  const ambientCredentials = yield* Effect.serviceOption(Credentials);
  const ambientHttp = yield* Effect.serviceOption(HttpClient.HttpClient);
  return Context.make(
    Credentials,
    Option.isSome(ambientCredentials)
      ? ambientCredentials.value
      : yield* Credentials.pipe(
          Effect.provide(CredentialsFromEnv),
          orDieCredentialsUnavailable("Render"),
        ),
  ).pipe(
    Context.add(
      HttpClient.HttpClient,
      Option.isSome(ambientHttp)
        ? ambientHttp.value
        : yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  );
});

/**
 * Resolve a `@distilled.cloud/render` operation once when the binding layer is
 * built, using credentials bound into `CurrentRuntimeContext` at runtime or the
 * deployer's ambient credentials otherwise.
 */
export const withCredentials = <I, O, E>(
  operation: (input: I) => Effect.Effect<O, E, RenderOpContext>,
): Effect.Effect<(input: I) => Effect.Effect<O, E>> =>
  Effect.map(
    operationContext,
    (context) => (input: I) => operation(input).pipe(Effect.provide(context)),
  );

/**
 * Resource shape for any host accepting {@link RenderServiceBinding}.
 */
export type RenderBindableHost = Resource<string, any, any, RenderServiceBinding>;
