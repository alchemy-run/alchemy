import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface PortalConfigurationBusinessProfile {
  headline?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
}

export interface PortalConfigurationFeatures {
  customerUpdate?: {
    allowedUpdates?: Array<Stripe.BillingPortal.ConfigurationCreateParams.Features.CustomerUpdate.AllowedUpdate>;
    enabled?: boolean;
  };
  invoiceHistory?: {
    enabled?: boolean;
  };
  paymentMethodUpdate?: {
    enabled?: boolean;
  };
  subscriptionCancel?: {
    cancellationReason?: {
      enabled?: boolean;
      options?: Array<Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionCancel.CancellationReason.Option>;
    };
    enabled?: boolean;
    mode?: Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionCancel.Mode;
    prorationBehavior?: Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionCancel.ProrationBehavior;
  };
  subscriptionPause?: {
    enabled?: boolean;
  };
  subscriptionUpdate?: {
    defaultAllowedUpdates?: Array<Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionUpdate.DefaultAllowedUpdate>;
    enabled?: boolean;
    products?: Array<{
      product: string;
      prices?: string[];
    }>;
    prorationBehavior?: Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionUpdate.ProrationBehavior;
  };
}

export interface PortalConfigurationProps {
  businessProfile?: PortalConfigurationBusinessProfile;
  defaultReturnUrl?: string;
  features?: PortalConfigurationFeatures;
  metadata?: Record<string, string>;
}

export interface PortalConfiguration
  extends Resource<"stripe::PortalConfiguration">,
    PortalConfigurationProps {
  id: string;
  object: "billing_portal.configuration";
  active: boolean;
  application?: string;
  created: number;
  isDefault: boolean;
  livemode: boolean;
  updated: number;
}

export const PortalConfiguration = Resource(
  "stripe::PortalConfiguration",
  async function (
    this: Context<PortalConfiguration>,
    _id: string,
    props: PortalConfigurationProps,
  ): Promise<PortalConfiguration> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.billingPortal.configurations.update(this.output.id, {
            active: false,
          });
        }
      } catch (error) {
        console.error("Error deactivating portal configuration:", error);
      }
      return this.destroy();
    }

    try {
      let configuration: Stripe.BillingPortal.Configuration;

      if (this.phase === "update" && this.output?.id) {
        const updateParams: Stripe.BillingPortal.ConfigurationUpdateParams = {
          business_profile: props.businessProfile
            ? {
                headline: props.businessProfile.headline,
                privacy_policy_url: props.businessProfile.privacyPolicyUrl,
                terms_of_service_url: props.businessProfile.termsOfServiceUrl,
              }
            : undefined,
          default_return_url: props.defaultReturnUrl,
          metadata: props.metadata,
        };

        if (props.features) {
          updateParams.features = {
            customer_update: props.features.customerUpdate
              ? {
                  allowed_updates:
                    props.features.customerUpdate.allowedUpdates || [],
                  enabled: props.features.customerUpdate.enabled || false,
                }
              : { enabled: false },
            invoice_history: props.features.invoiceHistory
              ? {
                  enabled: props.features.invoiceHistory.enabled || false,
                }
              : undefined,
            payment_method_update: props.features.paymentMethodUpdate
              ? {
                  enabled: props.features.paymentMethodUpdate.enabled || false,
                }
              : undefined,
            subscription_cancel: props.features.subscriptionCancel
              ? {
                  cancellation_reason: props.features.subscriptionCancel
                    .cancellationReason
                    ? {
                        enabled:
                          props.features.subscriptionCancel.cancellationReason
                            .enabled || false,
                        options:
                          props.features.subscriptionCancel.cancellationReason
                            .options || [],
                      }
                    : undefined,
                  enabled: props.features.subscriptionCancel.enabled || false,
                  mode: props.features.subscriptionCancel.mode || "immediately",
                  proration_behavior:
                    props.features.subscriptionCancel.prorationBehavior ||
                    "none",
                }
              : undefined,

            subscription_update: props.features.subscriptionUpdate
              ? {
                  default_allowed_updates:
                    props.features.subscriptionUpdate.defaultAllowedUpdates ||
                    [],
                  enabled: props.features.subscriptionUpdate.enabled || false,
                  products:
                    props.features.subscriptionUpdate.products?.map((p) => ({
                      product: p.product,
                      prices: p.prices || [],
                    })) || [],
                  proration_behavior:
                    props.features.subscriptionUpdate.prorationBehavior ||
                    "none",
                }
              : undefined,
          };
        }

        configuration = await stripe.billingPortal.configurations.update(
          this.output.id,
          updateParams,
        );
      } else {
        const createParams: Stripe.BillingPortal.ConfigurationCreateParams = {
          business_profile: props.businessProfile
            ? {
                headline: props.businessProfile.headline,
                privacy_policy_url: props.businessProfile.privacyPolicyUrl,
                terms_of_service_url: props.businessProfile.termsOfServiceUrl,
              }
            : undefined,
          default_return_url: props.defaultReturnUrl,
          metadata: props.metadata,
          features: {
            customer_update: { enabled: false },
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true },

            subscription_update: {
              enabled: false,
              default_allowed_updates: [],
              products: [],
              proration_behavior: "none",
            },
          },
        };

        if (props.features) {
          createParams.features = {
            customer_update: props.features.customerUpdate
              ? {
                  allowed_updates:
                    props.features.customerUpdate.allowedUpdates || [],
                  enabled: props.features.customerUpdate.enabled || false,
                }
              : { enabled: false },
            invoice_history: props.features.invoiceHistory
              ? {
                  enabled: props.features.invoiceHistory.enabled || false,
                }
              : undefined,
            payment_method_update: props.features.paymentMethodUpdate
              ? {
                  enabled: props.features.paymentMethodUpdate.enabled || false,
                }
              : undefined,
            subscription_cancel: props.features.subscriptionCancel
              ? {
                  cancellation_reason: props.features.subscriptionCancel
                    .cancellationReason
                    ? {
                        enabled:
                          props.features.subscriptionCancel.cancellationReason
                            .enabled || false,
                        options:
                          props.features.subscriptionCancel.cancellationReason
                            .options || [],
                      }
                    : undefined,
                  enabled: props.features.subscriptionCancel.enabled || false,
                  mode: props.features.subscriptionCancel.mode || "immediately",
                  proration_behavior:
                    props.features.subscriptionCancel.prorationBehavior ||
                    "none",
                }
              : undefined,

            subscription_update: props.features.subscriptionUpdate
              ? {
                  default_allowed_updates:
                    props.features.subscriptionUpdate.defaultAllowedUpdates ||
                    [],
                  enabled: props.features.subscriptionUpdate.enabled || false,
                  products:
                    props.features.subscriptionUpdate.products?.map((p) => ({
                      product: p.product,
                      prices: p.prices || [],
                    })) || [],
                  proration_behavior:
                    props.features.subscriptionUpdate.prorationBehavior ||
                    "none",
                }
              : undefined,
          };
        }

        configuration =
          await stripe.billingPortal.configurations.create(createParams);
      }

      return this({
        id: configuration.id,
        object: configuration.object,
        active: configuration.active,
        application:
          typeof configuration.application === "string"
            ? configuration.application
            : undefined,
        businessProfile: configuration.business_profile
          ? {
              headline: configuration.business_profile.headline || undefined,
              privacyPolicyUrl:
                configuration.business_profile.privacy_policy_url || undefined,
              termsOfServiceUrl:
                configuration.business_profile.terms_of_service_url ||
                undefined,
            }
          : undefined,
        created: configuration.created,
        defaultReturnUrl: configuration.default_return_url || undefined,
        features: {
          customerUpdate: configuration.features.customer_update
            ? {
                allowedUpdates:
                  configuration.features.customer_update.allowed_updates ||
                  undefined,
                enabled:
                  configuration.features.customer_update.enabled || undefined,
              }
            : undefined,
          invoiceHistory: configuration.features.invoice_history
            ? {
                enabled:
                  configuration.features.invoice_history.enabled || undefined,
              }
            : undefined,
          paymentMethodUpdate: configuration.features.payment_method_update
            ? {
                enabled:
                  configuration.features.payment_method_update.enabled ||
                  undefined,
              }
            : undefined,
          subscriptionCancel: configuration.features.subscription_cancel
            ? {
                cancellationReason: configuration.features.subscription_cancel
                  .cancellation_reason
                  ? {
                      enabled:
                        configuration.features.subscription_cancel
                          .cancellation_reason.enabled || undefined,
                      options:
                        configuration.features.subscription_cancel
                          .cancellation_reason.options || undefined,
                    }
                  : undefined,
                enabled:
                  configuration.features.subscription_cancel.enabled ||
                  undefined,
                mode:
                  configuration.features.subscription_cancel.mode || undefined,
                prorationBehavior:
                  configuration.features.subscription_cancel
                    .proration_behavior || undefined,
              }
            : undefined,

          subscriptionUpdate: configuration.features.subscription_update
            ? {
                defaultAllowedUpdates:
                  configuration.features.subscription_update
                    .default_allowed_updates || undefined,
                enabled:
                  configuration.features.subscription_update.enabled ||
                  undefined,
                products:
                  configuration.features.subscription_update.products?.map(
                    (p) => ({
                      product: p.product,
                      prices: p.prices || undefined,
                    }),
                  ) || undefined,
                prorationBehavior:
                  configuration.features.subscription_update
                    .proration_behavior || undefined,
              }
            : undefined,
        },
        isDefault: configuration.is_default,
        livemode: configuration.livemode,
        metadata: configuration.metadata || undefined,
        updated: configuration.updated,
      });
    } catch (error) {
      console.error("Error creating/updating portal configuration:", error);
      throw error;
    }
  },
);
