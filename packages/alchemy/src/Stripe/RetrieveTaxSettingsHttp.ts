import { Credentials } from "@distilled.cloud/stripe";
import { GetTaxSettings } from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { ResourceLike } from "../Resource.ts";
import { STRIPE_API_KEY_ENV } from "./AuthProvider.ts";
import {
  RetrieveTaxSettings,
  type RetrieveTaxSettingsRequest,
} from "./RetrieveTaxSettings.ts";
import { bindStripeEnv, makeStripeAuth, stripeApiKey } from "./StripeHttp.ts";
import type { TaxSettings } from "./TaxSettings.ts";

/**
 * HTTP implementation of {@link RetrieveTaxSettings}. Provide it on the
 * Function or Worker Effect. Tax Settings has no Stripe id — only the API
 * key is bound.
 *
 * @layer
 * @provides Stripe.RetrieveTaxSettings
 */
export const RetrieveTaxSettingsHttp = Layer.effect(
  RetrieveTaxSettings,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth = makeStripeAuth(context);

    return Effect.fn(function* (settings: TaxSettings) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (host !== undefined) {
          const token = yield* stripeApiKey(context);
          yield* bindStripeEnv(host, settings as unknown as ResourceLike, {
            [STRIPE_API_KEY_ENV]: Redacted.make(token),
          });
        }
      }
      return Effect.fn(`Stripe.RetrieveTaxSettings(${settings.LogicalId})`)(
        function* (request?: RetrieveTaxSettingsRequest) {
          return yield* auth.authorize(GetTaxSettings(request ?? {}));
        },
      );
    });
  }),
);
