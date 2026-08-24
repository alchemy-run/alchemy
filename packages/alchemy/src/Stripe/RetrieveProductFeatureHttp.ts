import { Credentials } from "@distilled.cloud/stripe";
import { GetProductsProductFeaturesId } from "@distilled.cloud/stripe/stripe";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ResourceLike } from "../Resource.ts";
import { sanitizeKey } from "../RuntimeContext.ts";
import type { ProductFeature } from "./ProductFeature.ts";
import { RetrieveProductFeature } from "./RetrieveProductFeature.ts";
import {
  asStringEffect,
  attachStripeToken,
  idEnvKey,
  makeStripeAuth,
} from "./StripeHttp.ts";

const productEnvKey = (resource: { readonly LogicalId: string }): string =>
  `STRIPE_PRODUCT_${sanitizeKey(resource.LogicalId)}`;

const envName = (key: string) => Config.string(key).pipe(Effect.orDie);

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
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          feature as unknown as ResourceLike,
          {
            [idKey]: feature.id,
            [productKey]: feature.product,
          },
          ["products_read"],
          "Stripe.RetrieveProductFeature",
        );
      }

      const id = globalThis.__ALCHEMY_RUNTIME__
        ? envName(idKey)
        : asStringEffect(feature.id);
      const product = globalThis.__ALCHEMY_RUNTIME__
        ? envName(productKey)
        : asStringEffect(feature.product);

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
