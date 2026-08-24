import { Credentials, CredentialsFromEnv } from "@distilled.cloud/stripe";
import type * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
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

export const makeStripeAuth = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
): StripeAuth => ({
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
    return eff.pipe(Effect.provideContext(ambient)) as Effect.Effect<
      A,
      E,
      RuntimeContext
    >;
  },
});

const envName = (key: string): Effect.Effect<string> =>
  Config.string(key).pipe(Effect.orDie);

export const asStringEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) {
    return value as Effect.Effect<string>;
  }
  return Effect.die("Stripe binding expected a resolved resource id");
};

const isEnvHost = (type: string | undefined): boolean =>
  type === "AWS.Lambda.Function" ||
  type === "AWS.ECS.Task" ||
  type === "AWS.ECS.Service" ||
  type === "Kubernetes.Deployment" ||
  type === "Kubernetes.Job" ||
  type === "Fly.Service" ||
  type === "Fly.Machine";

export const bindStripeEnv = (
  host: ResourceLike,
  resource: ResourceLike | undefined,
  env: Record<string, unknown>,
): Effect.Effect<void> => {
  const type = host.Type;
  const target = resource ?? host;
  if (isEnvHost(type)) {
    return (host as any).bind`${target}`({ env }) as Effect.Effect<void>;
  }
  if (type === "Cloudflare.Worker") {
    const bindings = Object.entries(env).map(([name, value]) =>
      Redacted.isRedacted(value) || name === STRIPE_API_KEY_ENV
        ? { type: "secret_text" as const, name, text: value }
        : { type: "plain_text" as const, name, text: value },
    );
    return (host as any).bind`${target}`({ bindings }) as Effect.Effect<void>;
  }
  return Effect.void;
};

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
    const token = yield* Token(`${host.LogicalId}StripeToken`);
    yield* token.bind(bindId, {
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
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

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
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

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
