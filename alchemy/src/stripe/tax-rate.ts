import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface TaxRateProps {
  displayName: string;
  percentage: number;
  inclusive: boolean;
  active?: boolean;
  country?: string;
  description?: string;
  jurisdiction?: string;
  metadata?: Record<string, string>;
  state?: string;
  taxType?: Stripe.TaxRateCreateParams.TaxType;
}

export interface TaxRate extends Resource<"stripe::TaxRate">, TaxRateProps {
  id: string;
  object: "tax_rate";
  created: number;
  livemode: boolean;
}

export const TaxRate = Resource(
  "stripe::TaxRate",
  async function (
    this: Context<TaxRate>,
    _id: string,
    props: TaxRateProps,
  ): Promise<TaxRate> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.taxRates.update(this.output.id, { active: false });
        }
      } catch (error) {
        console.error("Error deactivating tax rate:", error);
      }
      return this.destroy();
    }

    try {
      let taxRate: Stripe.TaxRate;

      if (this.phase === "update" && this.output?.id) {
        taxRate = await stripe.taxRates.update(this.output.id, {
          active: props.active,
          country: props.country,
          description: props.description,
          display_name: props.displayName,
          jurisdiction: props.jurisdiction,
          metadata: props.metadata,
          state: props.state,
          tax_type: props.taxType,
        });
      } else {
        taxRate = await stripe.taxRates.create({
          display_name: props.displayName,
          percentage: props.percentage,
          inclusive: props.inclusive,
          active: props.active,
          country: props.country,
          description: props.description,
          jurisdiction: props.jurisdiction,
          metadata: props.metadata,
          state: props.state,
          tax_type: props.taxType,
        });
      }

      return this({
        id: taxRate.id,
        object: taxRate.object,
        displayName: taxRate.display_name,
        percentage: taxRate.percentage,
        inclusive: taxRate.inclusive,
        active: taxRate.active,
        country: taxRate.country || undefined,
        description: taxRate.description || undefined,
        jurisdiction: taxRate.jurisdiction || undefined,
        metadata: taxRate.metadata || undefined,
        state: taxRate.state || undefined,
        taxType: taxRate.tax_type || undefined,
        created: taxRate.created,
        livemode: taxRate.livemode,
      });
    } catch (error) {
      console.error("Error creating/updating tax rate:", error);
      throw error;
    }
  },
);
