import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface PromotionCodeRestrictions {
  firstTimeTransaction?: boolean;
  minimumAmount?: number;
  minimumAmountCurrency?: string;
}

export interface PromotionCodeProps {
  coupon: string;
  code?: string;
  active?: boolean;
  customer?: string;
  expiresAt?: number;
  maxRedemptions?: number;
  metadata?: Record<string, string>;
  restrictions?: PromotionCodeRestrictions;
}

export interface PromotionCode
  extends Resource<"stripe::PromotionCode">,
    PromotionCodeProps {
  id: string;
  object: "promotion_code";
  created: number;
  livemode: boolean;
  timesRedeemed: number;
}

export const PromotionCode = Resource(
  "stripe::PromotionCode",
  async function (
    this: Context<PromotionCode>,
    _id: string,
    props: PromotionCodeProps,
  ): Promise<PromotionCode> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.promotionCodes.update(this.output.id, { active: false });
        }
      } catch (error) {
        console.error("Error deactivating promotion code:", error);
      }
      return this.destroy();
    }

    try {
      let promotionCode: Stripe.PromotionCode;

      if (this.phase === "update" && this.output?.id) {
        promotionCode = await stripe.promotionCodes.update(this.output.id, {
          active: props.active,
          metadata: props.metadata,
        });
      } else {
        const createParams: Stripe.PromotionCodeCreateParams = {
          coupon: props.coupon,
          code: props.code,
          active: props.active,
          customer: props.customer,
          expires_at: props.expiresAt,
          max_redemptions: props.maxRedemptions,
          metadata: props.metadata,
        };

        if (props.restrictions) {
          createParams.restrictions = {
            first_time_transaction: props.restrictions.firstTimeTransaction,
            minimum_amount: props.restrictions.minimumAmount,
            minimum_amount_currency: props.restrictions.minimumAmountCurrency,
          };
        }

        promotionCode = await stripe.promotionCodes.create(createParams);
      }

      return this({
        id: promotionCode.id,
        object: promotionCode.object,
        coupon:
          typeof promotionCode.coupon === "string"
            ? promotionCode.coupon
            : promotionCode.coupon.id,
        code: promotionCode.code,
        active: promotionCode.active,
        customer:
          typeof promotionCode.customer === "string"
            ? promotionCode.customer
            : promotionCode.customer?.id,
        expiresAt: promotionCode.expires_at || undefined,
        maxRedemptions: promotionCode.max_redemptions || undefined,
        metadata: promotionCode.metadata || undefined,
        restrictions: promotionCode.restrictions
          ? {
              firstTimeTransaction:
                promotionCode.restrictions.first_time_transaction || undefined,
              minimumAmount:
                promotionCode.restrictions.minimum_amount || undefined,
              minimumAmountCurrency:
                promotionCode.restrictions.minimum_amount_currency || undefined,
            }
          : undefined,
        created: promotionCode.created,
        livemode: promotionCode.livemode,
        timesRedeemed: promotionCode.times_redeemed,
      });
    } catch (error) {
      console.error("Error creating/updating promotion code:", error);
      throw error;
    }
  },
);
