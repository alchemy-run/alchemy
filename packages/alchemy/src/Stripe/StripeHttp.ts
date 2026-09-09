import {
  Credentials,
  CredentialsFromEnv,
  type Config as StripeCredentialsConfig,
} from "@distilled.cloud/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { isBindingHost } from "../AWS/Lambda/Function.ts";
import * as Binding from "../Binding.ts";
import { isWorker } from "../Cloudflare/Workers/Worker.ts";
import * as Output from "../Output.ts";
import { type Resource, type ResourceLike } from "../Resource.ts";
import { sanitizeKey, type RuntimeContext } from "../RuntimeContext.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import { RestrictedApiKey, type StripePermission } from "./RestrictedApiKey.ts";

/**
 * Shared scaffolding for HTTP Stripe bindings.
 *
 * Stripe has no native Worker/Lambda binding. Each host gets a
 * {@link RestrictedApiKey}; capabilities attach permissions via
 * `token.bind`. The token value (account secret, or a Dashboard RAK) plus
 * the resource id are injected into the host env.
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

export const idEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_ID_${sanitizeKey(resource.LogicalId)}`;

/** Built once — do not `Effect.provide` Credentials then HttpClient separately. */
const RuntimeLayer = CredentialsFromEnv.pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

const isFlyHost = (host: ResourceLike): boolean =>
  host.Type === "Fly.Service" || host.Type === "Fly.Machine";

export const makeStripeAuth = (options: {
  credentials: Effect.Effect<StripeCredentialsConfig> | undefined;
  http: HttpClient.HttpClient | undefined;
}): StripeAuth => ({
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> => {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return eff.pipe(Effect.provide(RuntimeLayer)) as Effect.Effect<
        A,
        E,
        RuntimeContext
      >;
    }
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

/**
 * Resolve plan-time Credentials/HttpClient with `serviceOption` so this
 * layer can be built hostless inside `providers()`. Missing services die
 * when a client is actually invoked, not at layer build.
 */
export const resolveStripeAuth = Effect.gen(function* () {
  const credentials = yield* Effect.serviceOption(Credentials).pipe(
    Effect.map(Option.getOrUndefined),
  );
  const http = yield* Effect.serviceOption(HttpClient.HttpClient).pipe(
    Effect.map(Option.getOrUndefined),
  );
  return makeStripeAuth({ credentials, http });
});

const envName = (key: string): Effect.Effect<string> =>
  Config.string(key).pipe(Effect.orDie);

const asResolvedString = (value: unknown): Effect.Effect<string> =>
  typeof value === "string"
    ? Effect.succeed(value)
    : Effect.die("Stripe binding expected a resolved resource id");

export const asStringEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Output.isOutput(value)) {
    return Effect.flatMap(
      value.asEffect(),
      asResolvedString,
    ) as Effect.Effect<string>;
  }
  if (Effect.isEffect(value)) {
    return Effect.flatMap(
      value as Effect.Effect<unknown>,
      asResolvedString,
    ) as Effect.Effect<string>;
  }
  return Effect.die("Stripe binding expected a resolved resource id");
};

type StripeHostBinding = {
  env?: Record<string, unknown>;
  bindings?: ReadonlyArray<{
    type: "secret_text" | "plain_text";
    name: string;
    text: string;
  }>;
};

const asBindableHost = (
  host: ResourceLike,
): Resource<string, object, object, StripeHostBinding> =>
  host as Resource<string, object, object, StripeHostBinding>;

/** Resolve Output/Effect/Redacted env values to a Cloudflare-safe string. */
const unwrapBindingText = (value: unknown): Effect.Effect<string> =>
  Effect.gen(function* () {
    let current: unknown = value;
    if (Output.isOutput(current)) {
      current = yield* current.asEffect();
    }
    if (Effect.isEffect(current)) {
      current = yield* current as Effect.Effect<unknown>;
    }
    if (Redacted.isRedacted(current)) {
      current = Redacted.value(current);
    }
    if (typeof current === "string") return current;
    if (current === undefined || current === null) {
      return yield* Effect.die("Stripe binding expected a string env value");
    }
    return JSON.stringify(current);
  }) as Effect.Effect<string>;

export const bindStripeEnv = (
  host: ResourceLike,
  resource: ResourceLike | undefined,
  env: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const target = resource ?? host;
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      resolved[name] = yield* unwrapBindingText(value);
    }
    if (isBindingHost(host) || isFlyHost(host)) {
      yield* asBindableHost(host).bind`${target}`({ env: resolved });
      return;
    }
    if (isWorker(host)) {
      const bindings = Object.entries(resolved).map(([name, text]) =>
        name === STRIPE_API_KEY_ENV
          ? { type: "secret_text" as const, name, text }
          : { type: "plain_text" as const, name, text },
      );
      yield* asBindableHost(host).bind`${target}`({ bindings });
      return;
    }
    return yield* Effect.die(
      `Stripe HTTP bindings cannot attach to host type '${host.Type}'`,
    );
  });

/**
 * Mint (or reuse) the host's {@link RestrictedApiKey}, attach this
 * capability's permissions via `token.bind`, and inject the key as
 * `STRIPE_API_KEY` (secret) plus any extra env onto the host.
 *
 * Stripe has no public mint API for restricted keys, so the token value
 * is a Dashboard RAK or the account secret — same shape as Cloudflare
 * AccountApiToken so a future mint can drop in without changing bindings.
 */
export const attachStripeToken = (
  resource: ResourceLike | undefined,
  extraEnv: Record<string, unknown>,
  permissions: readonly StripePermission[],
  bindId: string,
) =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const host = yield* Binding.Host;
    if (host === undefined) return;
    const Token = yield* RestrictedApiKey;
    const token = yield* Token(`${host.LogicalId}StripeToken`, {});
    const sid =
      resource !== undefined
        ? `${bindId}:${resource.LogicalId}`
        : `${bindId}:${host.LogicalId}`;
    yield* token.bind(sid, {
      permissions: [...permissions],
    });
    // One STRIPE_API_KEY on the host; resource ids bind onto the resource.
    yield* bindStripeEnv(host, undefined, {
      [STRIPE_API_KEY_ENV]: token.value,
    });
    if (Object.keys(extraEnv).length > 0) {
      yield* bindStripeEnv(host, resource, extraEnv);
    }
  });

/**
 * Resource-scoped binding: injects the Stripe object id into `idField`
 * and binds a permissioned {@link RestrictedApiKey} onto the host.
 */
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
    const auth = yield* resolveStripeAuth;

    return Effect.fn(function* (resource: StripeIdResource) {
      const key = idEnvKey(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          resource as unknown as ResourceLike,
          { [key]: resource.id },
          options.permissions,
          options.tag,
        );
      }

      const id = globalThis.__ALCHEMY_RUNTIME__
        ? envName(key)
        : asStringEffect(resource.id);
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, IdField>,
      ) {
        return yield* auth.authorize(
          options.operation({
            ...(request as object),
            [options.idField]: yield* id,
          } as I),
        );
      });
    });
  });

/**
 * Account-scoped binding: a permissioned {@link RestrictedApiKey} is bound.
 * The caller supplies the full distilled request.
 */
export const makeHttpStripeAccountBinding = <I, A, E>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
  permissions: readonly StripePermission[];
}) =>
  Effect.gen(function* () {
    const auth = yield* resolveStripeAuth;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          undefined,
          {},
          options.permissions,
          options.tag,
        );
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* auth.authorize(options.operation(request));
      });
    });
  });
