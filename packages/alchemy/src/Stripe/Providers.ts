import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { StripeAuth } from "./AuthProvider.ts";
import { BillingMeter, BillingMeterProvider } from "./BillingMeter.ts";
import {
  BillingPortalConfiguration,
  BillingPortalConfigurationProvider,
} from "./BillingPortalConfiguration.ts";
import { Coupon, CouponProvider } from "./Coupon.ts";
import * as Credentials from "./Credentials.ts";
import { Customer, CustomerProvider } from "./Customer.ts";
import {
  EntitlementsFeature,
  EntitlementsFeatureProvider,
} from "./EntitlementsFeature.ts";
import { PaymentLink, PaymentLinkProvider } from "./PaymentLink.ts";
import {
  PaymentMethodConfiguration,
  PaymentMethodConfigurationProvider,
} from "./PaymentMethodConfiguration.ts";
import { Price, PriceProvider } from "./Price.ts";
import { Product, ProductProvider } from "./Product.ts";
import { ProductFeature, ProductFeatureProvider } from "./ProductFeature.ts";
import { PromotionCode, PromotionCodeProvider } from "./PromotionCode.ts";
import { RadarValueList, RadarValueListProvider } from "./RadarValueList.ts";
import {
  RadarValueListItem,
  RadarValueListItemProvider,
} from "./RadarValueListItem.ts";
import { ShippingRate, ShippingRateProvider } from "./ShippingRate.ts";
import { TaxRate, TaxRateProvider } from "./TaxRate.ts";
import { WebhookEndpoint, WebhookEndpointProvider } from "./WebhookEndpoint.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Stripe",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Stripe resource providers, the Stripe
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Stripe from "alchemy/Stripe";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Stripe.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      BillingMeter,
      BillingPortalConfiguration,
      Coupon,
      Customer,
      EntitlementsFeature,
      PaymentLink,
      PaymentMethodConfiguration,
      Price,
      Product,
      ProductFeature,
      PromotionCode,
      RadarValueList,
      RadarValueListItem,
      ShippingRate,
      TaxRate,
      WebhookEndpoint,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        BillingMeterProvider(),
        BillingPortalConfigurationProvider(),
        CouponProvider(),
        CustomerProvider(),
        EntitlementsFeatureProvider(),
        PaymentLinkProvider(),
        PaymentMethodConfigurationProvider(),
        PriceProvider(),
        ProductProvider(),
        ProductFeatureProvider(),
        PromotionCodeProvider(),
        RadarValueListProvider(),
        RadarValueListItemProvider(),
        ShippingRateProvider(),
        TaxRateProvider(),
        WebhookEndpointProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(StripeAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
