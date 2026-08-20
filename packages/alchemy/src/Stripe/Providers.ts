import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { Account, AccountProvider } from "./Account.ts";
import {
  AccountExternalAccount,
  AccountExternalAccountProvider,
} from "./AccountExternalAccount.ts";
import { AccountPerson, AccountPersonProvider } from "./AccountPerson.ts";
import { Alert, AlertProvider } from "./Alert.ts";
import { ApplePayDomain, ApplePayDomainProvider } from "./ApplePayDomain.ts";
import { AppsSecret, AppsSecretProvider } from "./AppsSecret.ts";
import { StripeAuth } from "./AuthProvider.ts";
import {
  BillingPortalConfiguration,
  BillingPortalConfigurationProvider,
} from "./BillingPortalConfiguration.ts";
import { Coupon, CouponProvider } from "./Coupon.ts";
import { CreditGrant, CreditGrantProvider } from "./CreditGrant.ts";
import * as Credentials from "./Credentials.ts";
import { Customer, CustomerProvider } from "./Customer.ts";
import { CustomerTaxId, CustomerTaxIdProvider } from "./CustomerTaxId.ts";
import { Feature, FeatureProvider } from "./Feature.ts";
import { FileLink, FileLinkProvider } from "./FileLink.ts";
import { IssuingCard, IssuingCardProvider } from "./IssuingCard.ts";
import {
  IssuingCardholder,
  IssuingCardholderProvider,
} from "./IssuingCardholder.ts";
import {
  IssuingPersonalizationDesign,
  IssuingPersonalizationDesignProvider,
} from "./IssuingPersonalizationDesign.ts";
import { Meter, MeterProvider } from "./Meter.ts";
import { PaymentLink, PaymentLinkProvider } from "./PaymentLink.ts";
import {
  PaymentMethodConfiguration,
  PaymentMethodConfigurationProvider,
} from "./PaymentMethodConfiguration.ts";
import {
  PaymentMethodDomain,
  PaymentMethodDomainProvider,
} from "./PaymentMethodDomain.ts";
import { Plan, PlanProvider } from "./Plan.ts";
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
import { TaxRegistration, TaxRegistrationProvider } from "./TaxRegistration.ts";
import { TaxSettings, TaxSettingsProvider } from "./TaxSettings.ts";
import {
  TerminalConfiguration,
  TerminalConfigurationProvider,
} from "./TerminalConfiguration.ts";
import {
  TerminalLocation,
  TerminalLocationProvider,
} from "./TerminalLocation.ts";
import { TerminalReader, TerminalReaderProvider } from "./TerminalReader.ts";
import { WebhookEndpoint, WebhookEndpointProvider } from "./WebhookEndpoint.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Stripe",
) {}

/**
 * Build a layer that registers all Stripe resource providers, the Stripe
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Stripe from "alchemy/Stripe";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "Billing",
 *   { providers: Stripe.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const product = yield* Stripe.Product("pro-plan", { name: "Pro" });
 *     const price = yield* Stripe.Price("pro-monthly", {
 *       productId: product.productId,
 *       currency: "usd",
 *       unitAmount: 2000,
 *       recurring: { interval: "month" },
 *     });
 *     return { priceId: price.priceId };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Account,
      AccountExternalAccount,
      AccountPerson,
      Alert,
      ApplePayDomain,
      AppsSecret,
      BillingPortalConfiguration,
      Coupon,
      CreditGrant,
      Customer,
      CustomerTaxId,
      Feature,
      FileLink,
      IssuingCard,
      IssuingCardholder,
      IssuingPersonalizationDesign,
      Meter,
      PaymentLink,
      PaymentMethodConfiguration,
      PaymentMethodDomain,
      Plan,
      Price,
      Product,
      ProductFeature,
      PromotionCode,
      RadarValueList,
      RadarValueListItem,
      ShippingRate,
      TaxRate,
      TaxRegistration,
      TaxSettings,
      TerminalConfiguration,
      TerminalLocation,
      TerminalReader,
      WebhookEndpoint,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccountProvider(),
        AccountExternalAccountProvider(),
        AccountPersonProvider(),
        AlertProvider(),
        ApplePayDomainProvider(),
        AppsSecretProvider(),
        BillingPortalConfigurationProvider(),
        CouponProvider(),
        CreditGrantProvider(),
        CustomerProvider(),
        CustomerTaxIdProvider(),
        FeatureProvider(),
        FileLinkProvider(),
        IssuingCardProvider(),
        IssuingCardholderProvider(),
        IssuingPersonalizationDesignProvider(),
        MeterProvider(),
        PaymentLinkProvider(),
        PaymentMethodConfigurationProvider(),
        PaymentMethodDomainProvider(),
        PlanProvider(),
        PriceProvider(),
        ProductProvider(),
        ProductFeatureProvider(),
        PromotionCodeProvider(),
        RadarValueListProvider(),
        RadarValueListItemProvider(),
        ShippingRateProvider(),
        TaxRateProvider(),
        TaxRegistrationProvider(),
        TaxSettingsProvider(),
        TerminalConfigurationProvider(),
        TerminalLocationProvider(),
        TerminalReaderProvider(),
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
