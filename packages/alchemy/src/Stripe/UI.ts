import * as Layer from "effect/Layer";
import * as UIProvider from "../UI/UIProvider.ts";
import type { Account } from "./Account.ts";
import type { AccountExternalAccount } from "./AccountExternalAccount.ts";
import type { AccountPerson } from "./AccountPerson.ts";
import type { Alert } from "./Alert.ts";
import type { ApplePayDomain } from "./ApplePayDomain.ts";
import type { AppsSecret } from "./AppsSecret.ts";
import type { BillingMeter } from "./BillingMeter.ts";
import type { BillingPortalConfiguration } from "./BillingPortalConfiguration.ts";
import type { Coupon } from "./Coupon.ts";
import type { CreditGrant } from "./CreditGrant.ts";
import type { Customer } from "./Customer.ts";
import type { CustomerTaxId } from "./CustomerTaxId.ts";
import type { EntitlementsFeature } from "./EntitlementsFeature.ts";
import type { FileLink } from "./FileLink.ts";
import type { IssuingCard } from "./IssuingCard.ts";
import type { IssuingCardholder } from "./IssuingCardholder.ts";
import type { IssuingPersonalizationDesign } from "./IssuingPersonalizationDesign.ts";
import type { PaymentLink } from "./PaymentLink.ts";
import type { PaymentMethodConfiguration } from "./PaymentMethodConfiguration.ts";
import type { PaymentMethodDomain } from "./PaymentMethodDomain.ts";
import type { Plan } from "./Plan.ts";
import type { Price } from "./Price.ts";
import type { Product } from "./Product.ts";
import type { ProductFeature } from "./ProductFeature.ts";
import type { PromotionCode } from "./PromotionCode.ts";
import type { RadarValueList } from "./RadarValueList.ts";
import type { RadarValueListItem } from "./RadarValueListItem.ts";
import type { RestrictedApiKey } from "./RestrictedApiKey.ts";
import type { ShippingRate } from "./ShippingRate.ts";
import type { TaxRate } from "./TaxRate.ts";
import type { TaxRegistration } from "./TaxRegistration.ts";
import type { TaxSettings } from "./TaxSettings.ts";
import type { TerminalConfiguration } from "./TerminalConfiguration.ts";
import type { TerminalLocation } from "./TerminalLocation.ts";
import type { TerminalReader } from "./TerminalReader.ts";
import type { WebhookEndpoint } from "./WebhookEndpoint.ts";

/**
 * Dashboard UI providers for Stripe resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Stripe SDK code reaches the dashboard bundle.
 */

const STRIPE_PURPLE = "#635BFF";

const DASHBOARD = "https://dashboard.stripe.com";

const dashboardUrl = (
  path: string,
  id: string | undefined,
): string | undefined =>
  id === undefined ? undefined : `${DASHBOARD}/${path}/${id}`;

const httpsUrl = (host: string | undefined): string | undefined =>
  host === undefined ? undefined : `https://${host}`;

export const AccountUI = UIProvider.succeed<Account>("Stripe.Account", {
  displayName: "Stripe Account",
  icon: "building",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) =>
    ctx.attrs?.businessProfileName ?? ctx.attrs?.email ?? ctx.attrs?.id,
  link: (ctx) => ctx.attrs?.businessProfileUrl,
  consoleUrl: (ctx) => dashboardUrl("connect/accounts", ctx.attrs?.id),
  facts: (ctx) => [
    { label: "account id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "country", value: ctx.attrs?.country },
    { label: "email", value: ctx.attrs?.email, copy: true },
    { label: "charges enabled", value: ctx.attrs?.chargesEnabled },
    { label: "payouts enabled", value: ctx.attrs?.payoutsEnabled },
    { label: "details submitted", value: ctx.attrs?.detailsSubmitted },
  ],
});

export const AccountExternalAccountUI =
  UIProvider.succeed<AccountExternalAccount>("Stripe.AccountExternalAccount", {
    displayName: "Stripe External Account",
    icon: "banknote",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) =>
      ctx.attrs?.last4 === undefined
        ? ctx.attrs?.id
        : `${ctx.attrs.bankName ?? ctx.attrs.brand ?? ctx.attrs.object ?? ""} •••• ${ctx.attrs.last4}`.trim(),
    consoleUrl: (ctx) => dashboardUrl("connect/accounts", ctx.attrs?.account),
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.account, mono: true },
      { label: "kind", value: ctx.attrs?.object },
      { label: "last4", value: ctx.attrs?.last4, mono: true },
      { label: "bank / brand", value: ctx.attrs?.bankName ?? ctx.attrs?.brand },
      { label: "currency", value: ctx.attrs?.currency },
      { label: "status", value: ctx.attrs?.status },
    ],
  });

export const AccountPersonUI = UIProvider.succeed<AccountPerson>(
  "Stripe.AccountPerson",
  {
    displayName: "Stripe Account Person",
    icon: "user",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => {
      const name =
        `${ctx.attrs?.firstName ?? ""} ${ctx.attrs?.lastName ?? ""}`.trim();
      return name === "" ? (ctx.attrs?.email ?? ctx.attrs?.id) : name;
    },
    consoleUrl: (ctx) => dashboardUrl("connect/accounts", ctx.attrs?.account),
    facts: (ctx) => [
      { label: "person id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.account, mono: true },
      { label: "first name", value: ctx.attrs?.firstName },
      { label: "last name", value: ctx.attrs?.lastName },
      { label: "email", value: ctx.attrs?.email, copy: true },
      { label: "title", value: ctx.attrs?.relationship?.title },
      {
        label: "representative",
        value: ctx.attrs?.relationship?.representative,
      },
    ],
  },
);

export const AlertUI = UIProvider.succeed<Alert>("Stripe.Alert", {
  displayName: "Stripe Billing Alert",
  icon: "bell",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) => ctx.attrs?.title ?? ctx.attrs?.id,
  facts: (ctx) => [
    { label: "alert id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "title", value: ctx.attrs?.title, copy: true },
    { label: "type", value: ctx.attrs?.alertType },
    { label: "status", value: ctx.attrs?.status },
    { label: "meter", value: ctx.attrs?.usageThreshold?.meter, mono: true },
    { label: "threshold", value: ctx.attrs?.usageThreshold?.gte },
    { label: "recurrence", value: ctx.attrs?.usageThreshold?.recurrence },
  ],
});

export const ApplePayDomainUI = UIProvider.succeed<ApplePayDomain>(
  "Stripe.ApplePayDomain",
  {
    displayName: "Stripe Apple Pay Domain",
    icon: "globe",
    color: STRIPE_PURPLE,
    category: "config",
    summary: (ctx) => ctx.attrs?.domainName,
    link: (ctx) => httpsUrl(ctx.attrs?.domainName),
    consoleUrl: () => `${DASHBOARD}/settings/payment_method_domains`,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "domain",
        value: ctx.attrs?.domainName,
        href: httpsUrl(ctx.attrs?.domainName),
        copy: true,
      },
      { label: "created", value: ctx.attrs?.created },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const AppsSecretUI = UIProvider.succeed<AppsSecret>(
  "Stripe.AppsSecret",
  {
    displayName: "Stripe Apps Secret",
    icon: "key",
    color: STRIPE_PURPLE,
    category: "auth",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "secret id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
      { label: "scope", value: ctx.attrs?.scope?.type },
      { label: "scope user", value: ctx.attrs?.scope?.user, mono: true },
      { label: "expires at", value: ctx.attrs?.expiresAt },
      { label: "deleted", value: ctx.attrs?.deleted },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const BillingMeterUI = UIProvider.succeed<BillingMeter>(
  "Stripe.BillingMeter",
  {
    displayName: "Stripe Billing Meter",
    icon: "gauge",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.displayName ?? ctx.attrs?.eventName,
    consoleUrl: (ctx) => dashboardUrl("billing/meters", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "meter id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.displayName, copy: true },
      {
        label: "event name",
        value: ctx.attrs?.eventName,
        mono: true,
        copy: true,
      },
      {
        label: "aggregation",
        value: ctx.attrs?.defaultAggregation?.formula,
      },
      {
        label: "value key",
        value: ctx.attrs?.valueSettings?.eventPayloadKey,
        mono: true,
      },
      {
        label: "customer key",
        value: ctx.attrs?.customerMapping?.eventPayloadKey,
        mono: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const BillingPortalConfigurationUI =
  UIProvider.succeed<BillingPortalConfiguration>(
    "Stripe.BillingPortalConfiguration",
    {
      displayName: "Stripe Billing Portal Configuration",
      icon: "layout-template",
      color: STRIPE_PURPLE,
      category: "config",
      summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
      link: (ctx) => ctx.attrs?.loginPage?.url,
      consoleUrl: () => `${DASHBOARD}/settings/billing/portal`,
      facts: (ctx) => [
        {
          label: "configuration id",
          value: ctx.attrs?.id,
          mono: true,
          copy: true,
        },
        { label: "name", value: ctx.attrs?.name, copy: true },
        { label: "active", value: ctx.attrs?.active },
        { label: "default", value: ctx.attrs?.isDefault },
        { label: "headline", value: ctx.attrs?.businessProfile?.headline },
        {
          label: "return url",
          value: ctx.attrs?.defaultReturnUrl,
          href: ctx.attrs?.defaultReturnUrl,
        },
        {
          label: "login page",
          value: ctx.attrs?.loginPage?.url,
          href: ctx.attrs?.loginPage?.url,
          copy: true,
        },
      ],
    },
  );

export const CouponUI = UIProvider.succeed<Coupon>("Stripe.Coupon", {
  displayName: "Stripe Coupon",
  icon: "ticket",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
  consoleUrl: (ctx) => dashboardUrl("coupons", ctx.attrs?.id),
  facts: (ctx) => [
    { label: "coupon id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name, copy: true },
    {
      label: "discount",
      value:
        ctx.attrs?.percentOff !== undefined
          ? `${ctx.attrs.percentOff}%`
          : ctx.attrs?.amountOff !== undefined
            ? `${ctx.attrs.amountOff} ${ctx.attrs.currency ?? ""}`.trim()
            : undefined,
    },
    { label: "duration", value: ctx.attrs?.duration },
    { label: "max redemptions", value: ctx.attrs?.maxRedemptions },
    { label: "times redeemed", value: ctx.attrs?.timesRedeemed },
    { label: "valid", value: ctx.attrs?.valid },
  ],
});

export const CreditGrantUI = UIProvider.succeed<CreditGrant>(
  "Stripe.CreditGrant",
  {
    displayName: "Stripe Credit Grant",
    icon: "gift",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("customers", ctx.attrs?.customer),
    facts: (ctx) => [
      { label: "grant id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "customer", value: ctx.attrs?.customer, mono: true },
      {
        label: "amount",
        value:
          ctx.attrs?.amount?.monetary === undefined
            ? undefined
            : `${ctx.attrs.amount.monetary.value} ${ctx.attrs.amount.monetary.currency}`,
      },
      { label: "category", value: ctx.attrs?.category },
      { label: "effective at", value: ctx.attrs?.effectiveAt },
      { label: "expires at", value: ctx.attrs?.expiresAt },
    ],
  },
);

export const CustomerUI = UIProvider.succeed<Customer>("Stripe.Customer", {
  displayName: "Stripe Customer",
  icon: "user",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.email ?? ctx.attrs?.id,
  consoleUrl: (ctx) => dashboardUrl("customers", ctx.attrs?.id),
  facts: (ctx) => [
    { label: "customer id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "email", value: ctx.attrs?.email, copy: true },
    { label: "phone", value: ctx.attrs?.phone },
    { label: "description", value: ctx.attrs?.description },
    { label: "created", value: ctx.attrs?.created },
    { label: "live mode", value: ctx.attrs?.livemode },
  ],
});

export const CustomerTaxIdUI = UIProvider.succeed<CustomerTaxId>(
  "Stripe.CustomerTaxId",
  {
    displayName: "Stripe Customer Tax ID",
    icon: "id-card",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.value ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("customers", ctx.attrs?.customer),
    facts: (ctx) => [
      { label: "tax id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "customer", value: ctx.attrs?.customer, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "value", value: ctx.attrs?.value, mono: true, copy: true },
      { label: "country", value: ctx.attrs?.country },
      { label: "verification", value: ctx.attrs?.verificationStatus },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const EntitlementsFeatureUI = UIProvider.succeed<EntitlementsFeature>(
  "Stripe.EntitlementsFeature",
  {
    displayName: "Stripe Feature",
    icon: "sparkles",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.lookupKey,
    consoleUrl: (ctx) => dashboardUrl("features", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "feature id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "lookup key",
        value: ctx.attrs?.lookupKey,
        mono: true,
        copy: true,
      },
      { label: "active", value: ctx.attrs?.active },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const FileLinkUI = UIProvider.succeed<FileLink>("Stripe.FileLink", {
  displayName: "Stripe File Link",
  icon: "file",
  color: STRIPE_PURPLE,
  category: "storage",
  summary: (ctx) => ctx.attrs?.file ?? ctx.attrs?.id,
  link: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    { label: "link id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "file", value: ctx.attrs?.file, mono: true, copy: true },
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
    { label: "expired", value: ctx.attrs?.expired },
    { label: "expires at", value: ctx.attrs?.expiresAt },
    { label: "created", value: ctx.attrs?.created },
  ],
});

export const IssuingCardUI = UIProvider.succeed<IssuingCard>(
  "Stripe.IssuingCard",
  {
    displayName: "Stripe Issuing Card",
    icon: "credit-card",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) =>
      ctx.attrs?.last4 === undefined
        ? ctx.attrs?.id
        : `${ctx.attrs.brand ?? ""} •••• ${ctx.attrs.last4}`.trim(),
    consoleUrl: (ctx) => dashboardUrl("issuing/cards", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "card id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "cardholder", value: ctx.attrs?.cardholder, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
      { label: "last4", value: ctx.attrs?.last4, mono: true },
      {
        label: "expires",
        value:
          ctx.attrs?.expMonth !== undefined && ctx.attrs?.expYear !== undefined
            ? `${ctx.attrs.expMonth}/${ctx.attrs.expYear}`
            : undefined,
        mono: true,
      },
      { label: "currency", value: ctx.attrs?.currency },
    ],
  },
);

export const IssuingCardholderUI = UIProvider.succeed<IssuingCardholder>(
  "Stripe.IssuingCardholder",
  {
    displayName: "Stripe Issuing Cardholder",
    icon: "user-check",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("issuing/cardholders", ctx.attrs?.id),
    facts: (ctx) => [
      {
        label: "cardholder id",
        value: ctx.attrs?.id,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
      { label: "email", value: ctx.attrs?.email, copy: true },
      { label: "phone", value: ctx.attrs?.phoneNumber },
      { label: "country", value: ctx.attrs?.billing?.address?.country },
    ],
  },
);

export const IssuingPersonalizationDesignUI =
  UIProvider.succeed<IssuingPersonalizationDesign>(
    "Stripe.IssuingPersonalizationDesign",
    {
      displayName: "Stripe Issuing Personalization Design",
      icon: "palette",
      color: STRIPE_PURPLE,
      category: "billing",
      summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
      facts: (ctx) => [
        { label: "design id", value: ctx.attrs?.id, mono: true, copy: true },
        { label: "name", value: ctx.attrs?.name, copy: true },
        {
          label: "lookup key",
          value: ctx.attrs?.lookupKey,
          mono: true,
          copy: true,
        },
        {
          label: "physical bundle",
          value: ctx.attrs?.physicalBundle,
          mono: true,
        },
        { label: "card logo", value: ctx.attrs?.cardLogo, mono: true },
        { label: "status", value: ctx.attrs?.status },
        { label: "default", value: ctx.attrs?.isDefault },
      ],
    },
  );

export const PaymentLinkUI = UIProvider.succeed<PaymentLink>(
  "Stripe.PaymentLink",
  {
    displayName: "Stripe Payment Link",
    icon: "link",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.url ?? ctx.attrs?.id,
    link: (ctx) => ctx.attrs?.url,
    consoleUrl: (ctx) => dashboardUrl("payment-links", ctx.attrs?.id),
    facts: (ctx) => [
      {
        label: "payment link id",
        value: ctx.attrs?.id,
        mono: true,
        copy: true,
      },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        copy: true,
      },
      { label: "active", value: ctx.attrs?.active },
      { label: "line items", value: ctx.attrs?.lineItems?.length },
      { label: "currency", value: ctx.attrs?.currency },
      { label: "submit type", value: ctx.attrs?.submitType },
      { label: "promotion codes", value: ctx.attrs?.allowPromotionCodes },
    ],
  },
);

export const PaymentMethodConfigurationUI =
  UIProvider.succeed<PaymentMethodConfiguration>(
    "Stripe.PaymentMethodConfiguration",
    {
      displayName: "Stripe Payment Method Configuration",
      icon: "sliders-horizontal",
      color: STRIPE_PURPLE,
      category: "config",
      summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
      consoleUrl: (ctx) =>
        dashboardUrl("settings/payment_methods", ctx.attrs?.id),
      facts: (ctx) => [
        {
          label: "configuration id",
          value: ctx.attrs?.id,
          mono: true,
          copy: true,
        },
        { label: "name", value: ctx.attrs?.name, copy: true },
        { label: "active", value: ctx.attrs?.active },
        { label: "default", value: ctx.attrs?.isDefault },
        { label: "parent", value: ctx.attrs?.parent, mono: true },
        { label: "application", value: ctx.attrs?.application, mono: true },
        { label: "card available", value: ctx.attrs?.card?.available },
      ],
    },
  );

export const PaymentMethodDomainUI = UIProvider.succeed<PaymentMethodDomain>(
  "Stripe.PaymentMethodDomain",
  {
    displayName: "Stripe Payment Method Domain",
    icon: "globe",
    color: STRIPE_PURPLE,
    category: "config",
    summary: (ctx) => ctx.attrs?.domainName,
    link: (ctx) => httpsUrl(ctx.attrs?.domainName),
    consoleUrl: () => `${DASHBOARD}/settings/payment_method_domains`,
    facts: (ctx) => [
      { label: "domain id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "domain",
        value: ctx.attrs?.domainName,
        href: httpsUrl(ctx.attrs?.domainName),
        copy: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "apple pay", value: ctx.attrs?.applePay?.status },
      { label: "google pay", value: ctx.attrs?.googlePay?.status },
      { label: "link", value: ctx.attrs?.link?.status },
      { label: "paypal", value: ctx.attrs?.paypal?.status },
    ],
  },
);

export const PlanUI = UIProvider.succeed<Plan>("Stripe.Plan", {
  displayName: "Stripe Plan",
  icon: "receipt",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) => ctx.attrs?.nickname ?? ctx.attrs?.id,
  consoleUrl: (ctx) => dashboardUrl("products", ctx.attrs?.product),
  facts: (ctx) => [
    { label: "plan id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "product", value: ctx.attrs?.product, mono: true },
    { label: "amount (minor units)", value: ctx.attrs?.amount },
    { label: "currency", value: ctx.attrs?.currency },
    {
      label: "interval",
      value:
        ctx.attrs?.interval === undefined
          ? undefined
          : `every ${ctx.attrs.intervalCount ?? 1} ${ctx.attrs.interval}`,
    },
    { label: "usage type", value: ctx.attrs?.usageType },
    { label: "active", value: ctx.attrs?.active },
  ],
});

export const PriceUI = UIProvider.succeed<Price>("Stripe.Price", {
  displayName: "Stripe Price",
  icon: "tag",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) =>
    ctx.attrs?.nickname ?? ctx.attrs?.lookupKey ?? ctx.attrs?.id,
  consoleUrl: (ctx) => dashboardUrl("prices", ctx.attrs?.id),
  facts: (ctx) => [
    { label: "price id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "product", value: ctx.attrs?.product, mono: true },
    { label: "unit amount (minor units)", value: ctx.attrs?.unitAmount },
    { label: "currency", value: ctx.attrs?.currency },
    {
      label: "interval",
      value:
        ctx.attrs?.recurring === undefined
          ? ctx.attrs?.type
          : `every ${ctx.attrs.recurring.intervalCount ?? 1} ${ctx.attrs.recurring.interval}`,
    },
    {
      label: "lookup key",
      value: ctx.attrs?.lookupKey,
      mono: true,
      copy: true,
    },
    { label: "active", value: ctx.attrs?.active },
  ],
});

export const ProductUI = UIProvider.succeed<Product>("Stripe.Product", {
  displayName: "Stripe Product",
  icon: "package",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
  consoleUrl: (ctx) => dashboardUrl("products", ctx.attrs?.id),
  facts: (ctx) => [
    { label: "product id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "active", value: ctx.attrs?.active },
    { label: "description", value: ctx.attrs?.description },
    { label: "images", value: ctx.attrs?.images?.length },
    { label: "created", value: ctx.attrs?.created },
    { label: "live mode", value: ctx.attrs?.livemode },
  ],
});

export const ProductFeatureUI = UIProvider.succeed<ProductFeature>(
  "Stripe.ProductFeature",
  {
    displayName: "Stripe Product Feature",
    icon: "badge-check",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.entitlementFeature ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("products", ctx.attrs?.product),
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "product", value: ctx.attrs?.product, mono: true, copy: true },
      {
        label: "feature",
        value: ctx.attrs?.entitlementFeature,
        mono: true,
        copy: true,
      },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const PromotionCodeUI = UIProvider.succeed<PromotionCode>(
  "Stripe.PromotionCode",
  {
    displayName: "Stripe Promotion Code",
    icon: "percent",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.code ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("promotion_codes", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "promotion id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "code", value: ctx.attrs?.code, mono: true, copy: true },
      { label: "coupon", value: ctx.attrs?.couponId, mono: true },
      { label: "active", value: ctx.attrs?.active },
      { label: "max redemptions", value: ctx.attrs?.maxRedemptions },
      { label: "times redeemed", value: ctx.attrs?.timesRedeemed },
      { label: "expires at", value: ctx.attrs?.expiresAt },
    ],
  },
);

export const RadarValueListUI = UIProvider.succeed<RadarValueList>(
  "Stripe.RadarValueList",
  {
    displayName: "Stripe Radar Value List",
    icon: "list",
    color: STRIPE_PURPLE,
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.alias,
    consoleUrl: (ctx) => dashboardUrl("radar/lists", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "list id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "alias", value: ctx.attrs?.alias, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "item type", value: ctx.attrs?.itemType },
      { label: "created by", value: ctx.attrs?.createdBy },
      { label: "created", value: ctx.attrs?.created },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const RadarValueListItemUI = UIProvider.succeed<RadarValueListItem>(
  "Stripe.RadarValueListItem",
  {
    displayName: "Stripe Radar Value List Item",
    icon: "list-ordered",
    color: STRIPE_PURPLE,
    category: "security",
    summary: (ctx) => ctx.attrs?.value ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("radar/lists", ctx.attrs?.valueList),
    facts: (ctx) => [
      { label: "item id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "value list", value: ctx.attrs?.valueList, mono: true },
      { label: "value", value: ctx.attrs?.value, mono: true, copy: true },
      { label: "created by", value: ctx.attrs?.createdBy },
      { label: "created", value: ctx.attrs?.created },
    ],
  },
);

export const RestrictedApiKeyUI = UIProvider.succeed<RestrictedApiKey>(
  "Stripe.RestrictedApiKey",
  {
    displayName: "Stripe Restricted API Key",
    icon: "key",
    color: STRIPE_PURPLE,
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
    consoleUrl: () => `${DASHBOARD}/apikeys`,
    facts: (ctx) => [
      { label: "key id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "permissions", value: ctx.attrs?.permissions?.length },
      {
        label: "scopes",
        value: ctx.attrs?.permissions?.join(", "),
        mono: true,
      },
    ],
  },
);

export const ShippingRateUI = UIProvider.succeed<ShippingRate>(
  "Stripe.ShippingRate",
  {
    displayName: "Stripe Shipping Rate",
    icon: "truck",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.displayName ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("shipping-rates", ctx.attrs?.id),
    facts: (ctx) => [
      {
        label: "shipping rate id",
        value: ctx.attrs?.id,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.displayName, copy: true },
      { label: "amount (minor units)", value: ctx.attrs?.amount },
      { label: "currency", value: ctx.attrs?.currency },
      { label: "type", value: ctx.attrs?.type },
      { label: "active", value: ctx.attrs?.active },
      { label: "tax behavior", value: ctx.attrs?.taxBehavior },
    ],
  },
);

export const TaxRateUI = UIProvider.succeed<TaxRate>("Stripe.TaxRate", {
  displayName: "Stripe Tax Rate",
  icon: "percent",
  color: STRIPE_PURPLE,
  category: "billing",
  summary: (ctx) =>
    ctx.attrs?.displayName === undefined
      ? ctx.attrs?.id
      : ctx.attrs.percentage === undefined
        ? ctx.attrs.displayName
        : `${ctx.attrs.displayName} ${ctx.attrs.percentage}%`,
  consoleUrl: (ctx) => dashboardUrl("tax-rates", ctx.attrs?.id),
  facts: (ctx) => [
    { label: "tax rate id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.displayName, copy: true },
    { label: "percentage", value: ctx.attrs?.percentage },
    { label: "inclusive", value: ctx.attrs?.inclusive },
    { label: "active", value: ctx.attrs?.active },
    { label: "country", value: ctx.attrs?.country },
    { label: "jurisdiction", value: ctx.attrs?.jurisdiction },
  ],
});

export const TaxRegistrationUI = UIProvider.succeed<TaxRegistration>(
  "Stripe.TaxRegistration",
  {
    displayName: "Stripe Tax Registration",
    icon: "landmark",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.country ?? ctx.attrs?.id,
    consoleUrl: () => `${DASHBOARD}/tax/registrations`,
    facts: (ctx) => [
      {
        label: "registration id",
        value: ctx.attrs?.id,
        mono: true,
        copy: true,
      },
      { label: "country", value: ctx.attrs?.country },
      { label: "status", value: ctx.attrs?.status },
      { label: "active from", value: ctx.attrs?.activeFrom },
      { label: "expires at", value: ctx.attrs?.expiresAt },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const TaxSettingsUI = UIProvider.succeed<TaxSettings>(
  "Stripe.TaxSettings",
  {
    displayName: "Stripe Tax Settings",
    icon: "settings",
    color: STRIPE_PURPLE,
    category: "config",
    summary: (ctx) => ctx.attrs?.provider ?? ctx.attrs?.status,
    consoleUrl: () => `${DASHBOARD}/settings/tax`,
    facts: (ctx) => [
      { label: "provider", value: ctx.attrs?.provider },
      { label: "status", value: ctx.attrs?.status },
      { label: "tax behavior", value: ctx.attrs?.taxBehavior },
      { label: "tax code", value: ctx.attrs?.taxCode, mono: true },
      { label: "head office", value: ctx.attrs?.headOffice?.country },
      {
        label: "missing fields",
        value: ctx.attrs?.missingFields?.join(", "),
        mono: true,
      },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const TerminalConfigurationUI =
  UIProvider.succeed<TerminalConfiguration>("Stripe.TerminalConfiguration", {
    displayName: "Stripe Terminal Configuration",
    icon: "sliders-horizontal",
    color: STRIPE_PURPLE,
    category: "config",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.id,
    facts: (ctx) => [
      {
        label: "configuration id",
        value: ctx.attrs?.id,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "account default", value: ctx.attrs?.isAccountDefault },
      { label: "offline", value: ctx.attrs?.offline?.enabled },
      {
        label: "reboot window",
        value:
          ctx.attrs?.rebootWindow === undefined
            ? undefined
            : `${ctx.attrs.rebootWindow.startHour}:00-${ctx.attrs.rebootWindow.endHour}:00`,
        mono: true,
      },
      { label: "wifi", value: ctx.attrs?.wifi?.type },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  });

export const TerminalLocationUI = UIProvider.succeed<TerminalLocation>(
  "Stripe.TerminalLocation",
  {
    displayName: "Stripe Terminal Location",
    icon: "map-pin",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.displayName ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("terminal/locations", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "location id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.displayName, copy: true },
      { label: "city", value: ctx.attrs?.address?.city },
      { label: "country", value: ctx.attrs?.address?.country },
      { label: "phone", value: ctx.attrs?.phone },
      {
        label: "configuration",
        value: ctx.attrs?.configurationOverrides,
        mono: true,
      },
      { label: "live mode", value: ctx.attrs?.livemode },
    ],
  },
);

export const TerminalReaderUI = UIProvider.succeed<TerminalReader>(
  "Stripe.TerminalReader",
  {
    displayName: "Stripe Terminal Reader",
    icon: "monitor",
    color: STRIPE_PURPLE,
    category: "billing",
    summary: (ctx) => ctx.attrs?.label ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("terminal/readers", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "reader id", value: ctx.attrs?.id, mono: true, copy: true },
      { label: "label", value: ctx.attrs?.label, copy: true },
      { label: "device type", value: ctx.attrs?.deviceType },
      {
        label: "serial number",
        value: ctx.attrs?.serialNumber,
        mono: true,
        copy: true,
      },
      { label: "location", value: ctx.attrs?.location, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "software", value: ctx.attrs?.deviceSwVersion, mono: true },
    ],
  },
);

export const WebhookEndpointUI = UIProvider.succeed<WebhookEndpoint>(
  "Stripe.WebhookEndpoint",
  {
    displayName: "Stripe Webhook Endpoint",
    icon: "webhook",
    color: STRIPE_PURPLE,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.url ?? ctx.attrs?.id,
    consoleUrl: (ctx) => dashboardUrl("webhooks", ctx.attrs?.id),
    facts: (ctx) => [
      { label: "endpoint id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "events", value: ctx.attrs?.enabledEvents?.length },
      { label: "description", value: ctx.attrs?.description },
      { label: "api version", value: ctx.attrs?.apiVersion, mono: true },
      { label: "connect", value: ctx.attrs?.connect },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    Layer.mergeAll(
      AccountUI,
      AccountExternalAccountUI,
      AccountPersonUI,
      AlertUI,
      ApplePayDomainUI,
      AppsSecretUI,
      BillingMeterUI,
      BillingPortalConfigurationUI,
      CouponUI,
      CreditGrantUI,
      CustomerUI,
      CustomerTaxIdUI,
      EntitlementsFeatureUI,
      FileLinkUI,
      IssuingCardUI,
      IssuingCardholderUI,
      IssuingPersonalizationDesignUI,
      PaymentLinkUI,
    ),
    Layer.mergeAll(
      PaymentMethodConfigurationUI,
      PaymentMethodDomainUI,
      PlanUI,
      PriceUI,
      ProductUI,
      ProductFeatureUI,
      PromotionCodeUI,
      RadarValueListUI,
      RadarValueListItemUI,
      RestrictedApiKeyUI,
      ShippingRateUI,
      TaxRateUI,
      TaxRegistrationUI,
      TaxSettingsUI,
      TerminalConfigurationUI,
      TerminalLocationUI,
      TerminalReaderUI,
      WebhookEndpointUI,
    ),
  );
