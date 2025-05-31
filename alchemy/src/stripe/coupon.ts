import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

type CouponDuration = Stripe.CouponCreateParams.Duration;

export interface CouponProps {
  id?: string;
  duration: CouponDuration;
  amountOff?: number;
  currency?: string;
  durationInMonths?: number;
  maxRedemptions?: number;
  name?: string;
  percentOff?: number;
  redeemBy?: number;
  timesRedeemed?: number;
  valid?: boolean;
  metadata?: Record<string, string>;
}

export interface Coupon extends Resource<"stripe::Coupon">, CouponProps {
  id: string;
  object: "coupon";
  created: number;
  livemode: boolean;
}

export const Coupon = Resource(
  "stripe::Coupon",
  async function (
    this: Context<Coupon>,
    _id: string,
    props: CouponProps,
  ): Promise<Coupon> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.coupons.del(this.output.id);
        }
      } catch (error) {
        console.error("Error deleting coupon:", error);
      }
      return this.destroy();
    }

    try {
      let coupon: Stripe.Coupon;

      if (this.phase === "update" && this.output?.id) {
        coupon = await stripe.coupons.update(this.output.id, {
          name: props.name,
          metadata: props.metadata,
        });
      } else {
        const createParams: Stripe.CouponCreateParams = {
          duration: props.duration,
          name: props.name,
          metadata: props.metadata,
        };

        if (props.id) {
          createParams.id = props.id;
        }
        if (props.amountOff !== undefined) {
          createParams.amount_off = props.amountOff;
        }
        if (props.currency) {
          createParams.currency = props.currency;
        }
        if (props.durationInMonths !== undefined) {
          createParams.duration_in_months = props.durationInMonths;
        }
        if (props.maxRedemptions !== undefined) {
          createParams.max_redemptions = props.maxRedemptions;
        }
        if (props.percentOff !== undefined) {
          createParams.percent_off = props.percentOff;
        }
        if (props.redeemBy !== undefined) {
          createParams.redeem_by = props.redeemBy;
        }

        coupon = await stripe.coupons.create(createParams);
      }

      return this({
        id: coupon.id,
        object: coupon.object,
        duration: coupon.duration as CouponDuration,
        amountOff: coupon.amount_off || undefined,
        currency: coupon.currency || undefined,
        durationInMonths: coupon.duration_in_months || undefined,
        maxRedemptions: coupon.max_redemptions || undefined,
        name: coupon.name || undefined,
        percentOff: coupon.percent_off || undefined,
        redeemBy: coupon.redeem_by || undefined,
        timesRedeemed: coupon.times_redeemed || undefined,
        valid: coupon.valid,
        metadata: coupon.metadata || undefined,
        created: coupon.created,
        livemode: coupon.livemode,
      });
    } catch (error) {
      console.error("Error creating/updating coupon:", error);
      throw error;
    }
  },
);
