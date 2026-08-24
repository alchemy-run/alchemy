import { Credentials } from "@distilled.cloud/stripe";
import { GetAppsSecretsFind } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { AppsSecret, AppsSecretScopeType } from "./AppsSecret.ts";
import { RetrieveAppsSecret } from "./RetrieveAppsSecret.ts";
import {
  asStringEffect,
  attachStripeToken,
  makeStripeAuth,
} from "./StripeHttp.ts";

const nameEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_NAME_${sanitizeKey(resource.LogicalId)}`;

const scopeTypeEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_SCOPE_TYPE_${sanitizeKey(resource.LogicalId)}`;

const scopeUserEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_SCOPE_USER_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

const toOptionalStringEffect = (
  value: unknown,
): Effect.Effect<string | undefined> => {
  if (value === undefined || value === null || value === "") {
    return Effect.succeed(undefined);
  }
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) {
    return (value as Effect.Effect<unknown>).pipe(
      Effect.map((resolved) =>
        typeof resolved === "string" && resolved.length > 0
          ? resolved
          : undefined,
      ),
    ) as Effect.Effect<string | undefined>;
  }
  return Effect.succeed(undefined);
};

/**
 * HTTP implementation of {@link RetrieveAppsSecret}. Find is keyed by
 * `name` and `scope`.
 *
 * @layer
 * @provides Stripe.RetrieveAppsSecret
 */
export const RetrieveAppsSecretHttp = Layer.effect(
  RetrieveAppsSecret,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (secret: AppsSecret) {
      const nameKey = nameEnvKey(secret);
      const scopeTypeKey = scopeTypeEnvKey(secret);
      const scopeUserKey = scopeUserEnvKey(secret);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          secret as unknown as ResourceLike,
          {
            [nameKey]: secret.name,
            [scopeTypeKey]: secret.scope.type,
            [scopeUserKey]: secret.scope.user ?? "",
          },
          ["apps_secrets_read"],
          "Stripe.RetrieveAppsSecret",
        );
      }

      const name = globalThis.__ALCHEMY_RUNTIME__
        ? envName(nameKey)
        : asStringEffect(secret.name);
      const scopeType = globalThis.__ALCHEMY_RUNTIME__
        ? envName(scopeTypeKey)
        : asStringEffect(secret.scope.type);
      const scopeUser = globalThis.__ALCHEMY_RUNTIME__
        ? Config.string(scopeUserKey).pipe(Config.withDefault(""), Effect.orDie)
        : toOptionalStringEffect(secret.scope.user);

      return Effect.fn(`Stripe.RetrieveAppsSecret(${secret.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          const user = yield* scopeUser;
          return yield* auth.authorize(
            GetAppsSecretsFind({
              ...(request ?? {}),
              name: yield* name,
              scope: {
                type: (yield* scopeType) as AppsSecretScopeType,
                ...(user !== undefined && user.length > 0 ? { user } : {}),
              },
            }),
          );
        },
      );
    });
  }),
);
