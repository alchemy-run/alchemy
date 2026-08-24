import { Credentials } from "@distilled.cloud/stripe";
import { PostTaxSettings } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ResourceLike } from "../Resource.ts";
import { attachStripeToken, makeStripeAuth } from "./StripeHttp.ts";
import type { TaxSettings } from "./TaxSettings.ts";
import {
  UpdateTaxSettings,
  type UpdateTaxSettingsRequest,
} from "./UpdateTaxSettings.ts";

/**
 * HTTP implementation of {@link UpdateTaxSettings}. Provide it on the
 * Function or Worker Effect. Tax Settings has no Stripe id — only the API
 * key is bound.
 *
 * @layer
 * @provides Stripe.UpdateTaxSettings
 */
export const UpdateTaxSettingsHttp = Layer.effect(
  UpdateTaxSettings,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (settings: TaxSettings) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* attachStripeToken(
          settings as unknown as ResourceLike,
          {},
          ["tax_write"],
          "Stripe.UpdateTaxSettings",
        );
      }
      return Effect.fn(`Stripe.UpdateTaxSettings(${settings.LogicalId})`)(
        function* (request?: UpdateTaxSettingsRequest) {
          return yield* auth.authorize(PostTaxSettings(request ?? {}));
        },
      );
    });
  }),
);
