import {
  Credentials,
  DEFAULT_API_BASE_URL,
  type Config as StripeCredentialsConfig,
} from "@distilled.cloud/stripe";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { isBindingHost } from "../AWS/Lambda/Function.ts";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import { type Resource, type ResourceLike } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import { RestrictedApiKey, type StripePermission } from "./RestrictedApiKey.ts";

/**
 * Shared scaffolding for HTTP Stripe bindings.
 *
 * Stripe has no native Worker binding. Secrets and resource ids are
 * registered via `yield* token.value` / `yield* resource.id` so
 * RuntimeContext.set + packEnvValueKeepRedacted emit `secret_text`.
 * Do not push raw `{ type: "secret_text", text }` items — the Worker
 * provider forwards those to the wire un-resolved. Do not
 * `Output.asEffect` + unwrap at bind time — that resolves before the
 * RestrictedApiKey exists.
 *
 * NOT exported from `index.ts`.
 */

export interface StripeIdResource {
  readonly LogicalId: string;
  readonly id: unknown;
}

export interface StripeAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

const isFlyHost = (host: ResourceLike): boolean =>
  host.Type === "Fly.Service" || host.Type === "Fly.Machine";

type EnvHostBinding = {
  env?: Record<string, unknown>;
};

const asEnvHost = (
  host: ResourceLike,
): Resource<string, object, object, EnvHostBinding> =>
  host as Resource<string, object, object, EnvHostBinding>;

/**
 * Accessor for a bound RestrictedApiKey value. The `yield*` of `token.value`
 * is RuntimeContext.set — it does not resolve the secret at plan time.
 */
export const authorizeWith =
  (token: { value: Effect.Effect<Redacted.Redacted<string>> }) =>
  <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> =>
    token.value.pipe(
      Effect.flatMap((apiKey) =>
        eff.pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              apiKey,
              apiBaseUrl: DEFAULT_API_BASE_URL,
            } satisfies StripeCredentialsConfig),
          ),
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    ) as Effect.Effect<A, E, RuntimeContext>;

export const makeStripeAuth = (options: {
  credentials: Effect.Effect<StripeCredentialsConfig> | undefined;
  http: HttpClient.HttpClient | undefined;
}): StripeAuth => ({
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> => {
    if (options.credentials === undefined || options.http === undefined) {
      return Effect.die(
        "Stripe HTTP binding missing Credentials or HttpClient at plan time",
      ) as Effect.Effect<A, E, RuntimeContext>;
    }
    return eff.pipe(
      Effect.provideService(Credentials, options.credentials),
      Effect.provideService(HttpClient.HttpClient, options.http),
    ) as Effect.Effect<A, E, RuntimeContext>;
  },
});

export const resolveStripeAuth = Effect.gen(function* () {
  const credentials = yield* Effect.serviceOption(Credentials).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const http = yield* Effect.serviceOption(HttpClient.HttpClient).pipe(
    Effect.map(Option.getOrUndefined),
  );
  return makeStripeAuth({ credentials, http });
});

/**
 * Bind an Output (or plain string) at init. `yield*` this at bind time so
 * RuntimeContext.set runs; the inner Effect is the runtime getter.
 * Never unwrap the Output to a string here.
 */
export const asStringEffect = (
  value: unknown,
): Effect.Effect<Effect.Effect<string>> => {
  if (typeof value === "string") {
    return Effect.succeed(Effect.succeed(value));
  }
  if (Output.isOutput(value)) {
    return value.asEffect() as Effect.Effect<Effect.Effect<string>>;
  }
  if (Effect.isEffect(value)) {
    return Effect.succeed(value as Effect.Effect<string>);
  }
  return Effect.die("Stripe binding expected a resolved resource id");
};

/** Like {@link asStringEffect} for optional string fields. */
export const asOptionalStringEffect = (
  value: unknown,
): Effect.Effect<Effect.Effect<string | undefined>> => {
  if (value === undefined || value === null || value === "") {
    return Effect.succeed(Effect.succeed(undefined));
  }
  return asStringEffect(value).pipe(
    Effect.map((inner) =>
      inner.pipe(Effect.map((s) => (s.length > 0 ? s : undefined))),
    ),
  );
};

/**
 * Mint (or reuse) the host's RestrictedApiKey and attach permissions.
 * Returns a runtime accessor for the key value (`yield* token.value`).
 * Lambda/ECS/Fly also receive `{ env: { STRIPE_API_KEY } }` because those
 * hosts ship env through their binding contract. Workers do not — their
 * contract is `bindings[]` and would leak an unresolved Output.
 */
const missingHostToken = {
  value: Effect.die("Stripe token accessed without a host") as Effect.Effect<
    Redacted.Redacted<string>
  >,
};

export const attachStripeToken = (
  resource: ResourceLike | undefined,
  permissions: readonly StripePermission[],
  bindId: string,
) =>
  Effect.gen(function* () {
    const host = yield* Binding.Host;
    if (host === undefined) {
      return missingHostToken;
    }
    const Token = yield* RestrictedApiKey;
    const token = yield* Token(`${host.LogicalId}StripeToken`, {});
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const sid =
        resource !== undefined
          ? `${bindId}:${resource.LogicalId}`
          : `${bindId}:${host.LogicalId}`;
      yield* token.bind(sid, {
        permissions: [...permissions],
      });
      // Lambda/ECS/Fly ship env through their binding contract. Workers
      // pick the secret up from RuntimeContext.set via `yield* token.value`
      // below — do not host.bind({ env }) or hand-build secret_text.
      if (isBindingHost(host) || isFlyHost(host)) {
        yield* asEnvHost(host).bind`${host}`({
          env: { [STRIPE_API_KEY_ENV]: token.value },
        });
      }
    }
    return { value: yield* token.value };
  });

export const makeHttpStripeIdBinding = <
  I extends Record<IdField, string>,
  A,
  E,
  IdField extends string,
>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
  idField: IdField;
  permissions: readonly StripePermission[];
}) =>
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* (resource: StripeIdResource) {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        resource as unknown as ResourceLike,
        options.permissions,
        options.tag,
      );
      const id = yield* asStringEffect(resource.id);
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, IdField>,
      ) {
        return yield* auth(
          options.operation({
            ...(request as object),
            [options.idField]: yield* id,
          } as I),
        );
      });
    });
  });

export const makeHttpStripeAccountBinding = <I, A, E>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
  permissions: readonly StripePermission[];
}) =>
  Effect.gen(function* () {
    const ambient = yield* resolveStripeAuth;

    return Effect.fn(function* () {
      const host = yield* Binding.Host;
      const bound = yield* attachStripeToken(
        undefined,
        options.permissions,
        options.tag,
      );
      const auth =
        host !== undefined ? authorizeWith(bound) : ambient.authorize;

      return Effect.fn(options.tag)(function* (request: I) {
        return yield* auth(options.operation(request));
      });
    });
  });
