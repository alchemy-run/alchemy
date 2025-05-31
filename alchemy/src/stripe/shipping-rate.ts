import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface ShippingRateDeliveryEstimate {
  minimum?: {
    unit: Stripe.ShippingRateCreateParams.DeliveryEstimate.Minimum.Unit;
    value: number;
  };
  maximum?: {
    unit: Stripe.ShippingRateCreateParams.DeliveryEstimate.Maximum.Unit;
    value: number;
  };
}

export interface ShippingRateFixedAmount {
  amount: number;
  currency: string;
  currencyOptions?: Record<
    string,
    {
      amount: number;
      taxBehavior?: Stripe.ShippingRateCreateParams.FixedAmount.CurrencyOptions.TaxBehavior;
    }
  >;
}

export interface ShippingRateProps {
  displayName: string;
  fixedAmount?: ShippingRateFixedAmount;
  deliveryEstimate?: ShippingRateDeliveryEstimate;
  metadata?: Record<string, string>;
  active?: boolean;
  taxBehavior?: Stripe.ShippingRateCreateParams.TaxBehavior;
  taxCode?: string;
  type?: "fixed_amount";
}

export interface ShippingRate
  extends Resource<"stripe::ShippingRate">,
    ShippingRateProps {
  id: string;
  object: "shipping_rate";
  created: number;
  livemode: boolean;
}

export const ShippingRate = Resource(
  "stripe::ShippingRate",
  async function (
    this: Context<ShippingRate>,
    _id: string,
    props: ShippingRateProps,
  ): Promise<ShippingRate> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.shippingRates.update(this.output.id, { active: false });
        }
      } catch (error) {
        console.error("Error deactivating shipping rate:", error);
      }
      return this.destroy();
    }

    try {
      let shippingRate: Stripe.ShippingRate;

      if (this.phase === "update" && this.output?.id) {
        const updateParams: any = {
          metadata: props.metadata,
          tax_behavior: props.taxBehavior,
        };
        if (props.active !== undefined) updateParams.active = props.active;
        shippingRate = await stripe.shippingRates.update(
          this.output.id,
          updateParams,
        );
      } else {
        const createParams: Stripe.ShippingRateCreateParams = {
          display_name: props.displayName,
          metadata: props.metadata,

          tax_behavior: props.taxBehavior,
          tax_code: props.taxCode,
          type: props.type,
        };

        if (props.fixedAmount) {
          createParams.fixed_amount = {
            amount: props.fixedAmount.amount,
            currency: props.fixedAmount.currency,
            currency_options: props.fixedAmount.currencyOptions
              ? Object.fromEntries(
                  Object.entries(props.fixedAmount.currencyOptions).map(
                    ([key, value]) => [
                      key,
                      {
                        amount: value.amount,
                        tax_behavior: value.taxBehavior,
                      },
                    ],
                  ),
                )
              : undefined,
          };
        }

        if (props.deliveryEstimate) {
          createParams.delivery_estimate = {
            minimum: props.deliveryEstimate.minimum
              ? {
                  unit: props.deliveryEstimate.minimum.unit,
                  value: props.deliveryEstimate.minimum.value,
                }
              : undefined,
            maximum: props.deliveryEstimate.maximum
              ? {
                  unit: props.deliveryEstimate.maximum.unit,
                  value: props.deliveryEstimate.maximum.value,
                }
              : undefined,
          };
        }

        shippingRate = await stripe.shippingRates.create(createParams);
      }

      return this({
        id: shippingRate.id,
        object: shippingRate.object,
        displayName: shippingRate.display_name || "",
        fixedAmount: shippingRate.fixed_amount
          ? {
              amount: shippingRate.fixed_amount.amount,
              currency: shippingRate.fixed_amount.currency,
              currencyOptions: shippingRate.fixed_amount.currency_options
                ? Object.fromEntries(
                    Object.entries(
                      shippingRate.fixed_amount.currency_options,
                    ).map(([key, value]) => [
                      key,
                      {
                        amount: value.amount,
                        taxBehavior: value.tax_behavior,
                      },
                    ]),
                  )
                : undefined,
            }
          : undefined,
        deliveryEstimate: shippingRate.delivery_estimate
          ? {
              minimum: shippingRate.delivery_estimate.minimum
                ? {
                    unit: shippingRate.delivery_estimate.minimum.unit,
                    value: shippingRate.delivery_estimate.minimum.value,
                  }
                : undefined,
              maximum: shippingRate.delivery_estimate.maximum
                ? {
                    unit: shippingRate.delivery_estimate.maximum.unit,
                    value: shippingRate.delivery_estimate.maximum.value,
                  }
                : undefined,
            }
          : undefined,
        metadata: shippingRate.metadata || undefined,
        active: shippingRate.active,
        taxBehavior: shippingRate.tax_behavior || undefined,
        taxCode:
          typeof shippingRate.tax_code === "string"
            ? shippingRate.tax_code
            : undefined,
        type: shippingRate.type || undefined,
        created: shippingRate.created,
        livemode: shippingRate.livemode,
      });
    } catch (error) {
      console.error("Error creating/updating shipping rate:", error);
      throw error;
    }
  },
);
