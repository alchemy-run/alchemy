import { Credentials } from "@distilled.cloud/stripe";
import { GetProductsProductFeaturesId } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import type { ProductFeature } from "./ProductFeature.ts";
import { RetrieveProductFeature } from "./RetrieveProductFeature.ts";
import {
  bindStripeEnv,
  idEnvKey,
  makeStripeAuth,
  stripeApiKey,
} from "./StripeHttp.ts";

const productEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_PRODUCT_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

const toIdEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) return value as Effect.Effect<string>;
  return Effect.die("Stripe binding expected a resolved id");
};

/**
 * HTTP implementation of {@link RetrieveProductFeature}. The list-item
 * retrieve takes both `product` and `id`.
 *
 * @layer
 * @provides Stripe.RetrieveProductFeature
 */
export const RetrieveProductFeatureHttp = Layer.effect(
  RetrieveProductFeature,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (feature: ProductFeature) {
      const idKey = idEnvKey(feature);
      const productKey = productEnvKey(feature);
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return Effect.fn(`Stripe.RetrieveProductFeature(${feature.LogicalId})`)(
          function* (request?: { expand?: string[] }) {
            return yield* auth.authorize(
              GetProductsProductFeaturesId({
                ...(request ?? {}),
                id: yield* envName(idKey),
                product: yield* envName(productKey),
              }),
            );
          },
        );
      }

      const host = yield* Binding.Host;
      if (host !== undefined) {
        const token = yield* stripeApiKey(context);
        yield* bindStripeEnv(host, feature as unknown as ResourceLike, {
          [STRIPE_API_KEY_ENV]: Redacted.make(token),
          [idKey]: feature.id,
          [productKey]: feature.product,
        });
      }

      const id =
        typeof feature.id === "string"
          ? Effect.succeed(feature.id)
          : toIdEffect(yield* feature.id as unknown as Effect.Effect<unknown>);
      const product =
        typeof feature.product === "string"
          ? Effect.succeed(feature.product)
          : toIdEffect(
              yield* feature.product as unknown as Effect.Effect<unknown>,
            );

      return Effect.fn(`Stripe.RetrieveProductFeature(${feature.LogicalId})`)(
        function* (request?: { expand?: string[] }) {
          return yield* auth.authorize(
            GetProductsProductFeaturesId({
              ...(request ?? {}),
              id: yield* id,
              product: yield* product,
            }),
          );
        },
      );
    });
  }),
);
