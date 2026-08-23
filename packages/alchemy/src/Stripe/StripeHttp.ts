import { Credentials, CredentialsFromEnv } from "@distilled.cloud/stripe";
import type * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey, type RuntimeContext } from "../RuntimeContext.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";

/**
 * Shared scaffolding for HTTP Stripe bindings.
 *
 * Stripe has no native Worker/Lambda binding. This layer captures the
 * ambient API key during stack-eval and, when the host is a Lambda,
 * Worker, or Fly Service/Machine, injects `STRIPE_API_KEY` plus the
 * bound resource id into the host env. Runtime calls read those via
 * {@link CredentialsFromEnv}.
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

export const makeStripeAuth = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
): StripeAuth => ({
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ): Effect.Effect<A, E, RuntimeContext> => {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return eff.pipe(
        Effect.provide(CredentialsFromEnv),
        Effect.provide(FetchHttpClient.layer),
      ) as Effect.Effect<A, E, RuntimeContext>;
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

const toIdEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) {
    return value as Effect.Effect<string>;
  }
  return Effect.die("Stripe binding expected a resolved resource id");
};

export const stripeApiKey = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
) =>
  Credentials.pipe(
    Effect.provideContext(ambient),
    Effect.flatMap((resolve) => resolve),
    Effect.map((cfg) => Redacted.value(cfg.apiKey)),
  );

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
) => {
  const type = host.Type;
  const target = resource ?? host;
  if (isEnvHost(type)) {
    return (host as any).bind`${target}`({ env });
  }
  if (type === "Cloudflare.Worker") {
    const bindings = Object.entries(env).map(([name, value]) =>
      Redacted.isRedacted(value)
        ? { type: "secret_text" as const, name, text: value }
        : { type: "plain_text" as const, name, text: value },
    );
    return (host as any).bind`${target}`({ bindings });
  }
  return Effect.void;
};

/**
 * Resource-scoped binding: injects the Stripe object id into `idField`
 * and binds the API key + id onto the host.
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
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (resource: StripeIdResource) {
      const key = idEnvKey(resource);
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
          request?: Omit<I, IdField>,
        ) {
          return yield* auth.authorize(
            options.operation({
              ...(request as object),
              [options.idField]: yield* envName(key),
            } as I),
          );
        });
      }

      const host = yield* Binding.Host;
      if (host !== undefined) {
        const token = yield* stripeApiKey(context);
        yield* bindStripeEnv(host, resource as unknown as ResourceLike, {
          [STRIPE_API_KEY_ENV]: Redacted.make(token),
          [key]: resource.id,
        });
      }

      const id =
        typeof resource.id === "string"
          ? Effect.succeed(resource.id)
          : toIdEffect(yield* resource.id as unknown as Effect.Effect<unknown>);
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
 * Account-scoped binding: only the API key is bound. The caller supplies
 * the full distilled request.
 */
export const makeHttpStripeAccountBinding = <I, A, E>(options: {
  tag: string;
  operation: (
    input: I,
  ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (host !== undefined) {
          const token = yield* stripeApiKey(context);
          yield* bindStripeEnv(host, undefined, {
            [STRIPE_API_KEY_ENV]: Redacted.make(token),
          });
        }
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* auth.authorize(options.operation(request));
      });
    });
  });
