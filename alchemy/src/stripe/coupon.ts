import type Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import type { Secret } from "../secret.ts";
import { logger } from "../util/logger.ts";
import {
  createStripeClient,
  handleStripeDeleteError,
  isStripeConflictError,
} from "./client.ts";

type CouponDuration = Stripe.CouponCreateParams.Duration;

/**
 * Properties for creating a Stripe coupon
 */
export interface CouponProps {
  /**
   * Unique string of your choice that will be used to identify this coupon when applying it to a customer
   */
  id?: string;

  /**
   * Specifies how long the discount will be in effect
   */
  duration: CouponDuration;

  /**
   * A positive integer representing the amount to subtract from an invoice total (required if percent_off is not passed)
   */
  amountOff?: number;

  /**
   * Three-letter ISO code for the currency of the amount_off parameter (required if amount_off is passed)
   */
  currency?: string;

  /**
   * Required only if duration is repeating, in which case it must be a positive integer that specifies the number of months the discount will be in effect
   */
  durationInMonths?: number;

  /**
   * A positive integer specifying the number of times the coupon can be redeemed before it's no longer valid
   */
  maxRedemptions?: number;

  /**
   * Name of the coupon displayed to customers on, for instance invoices, or receipts
   */
  name?: string;

  /**
   * A positive float larger than 0, and smaller or equal to 100, that represents the discount the coupon will apply (required if amount_off is not passed)
   */
  percentOff?: number;

  /**
   * Unix timestamp specifying the last time at which the coupon can be redeemed
   */
  redeemBy?: number;

  /**
   * Number of times this coupon has been applied to a customer
   */
  timesRedeemed?: number;

  /**
   * Taking account of the above properties, whether this coupon can still be applied to a customer
   */
  valid?: boolean;

  /**
   * Set of key-value pairs that you can attach to an object
   */
  metadata?: Record<string, string>;

  /**
   * API key to use (overrides environment variable)
   */
  apiKey?: Secret;

  /**
   * If true, adopt existing resource if creation fails due to conflict
   */
  adopt?: boolean;
}

/**
 * Output from the Stripe coupon
 */
export interface Coupon extends Resource<"stripe::Coupon">, CouponProps {
  /**
   * The ID of the coupon
   */
  id: string;

  /**
   * String representing the object's type
   */
  object: "coupon";

  /**
   * Time at which the object was created
   */
  created: number;

  /**
   * Has the value true if the object exists in live mode or the value false if the object exists in test mode
   */
  livemode: boolean;
}

/**
 * Create and manage Stripe coupons for discounts
 *
 * @example
 * // Create a percentage-based coupon
 * const percentageCoupon = await Coupon("summer-sale", {
 *   id: "SUMMER25",
 *   duration: "once",
 *   percentOff: 25,
 *   name: "Summer Sale 25% Off",
 *   maxRedemptions: 1000,
 *   metadata: {
 *     campaign: "summer_2024",
 *     type: "seasonal"
 *   }
 * });
 *
 * @example
 * // Create a fixed amount coupon
 * const fixedAmountCoupon = await Coupon("new-customer", {
 *   id: "WELCOME10",
 *   duration: "once",
 *   amountOff: 1000,
 *   currency: "usd",
 *   name: "Welcome $10 Off",
 *   metadata: {
 *     type: "welcome",
 *     target: "new_customers"
 *   }
 * });
 *
 * @example
 * // Create a repeating coupon for subscriptions
 * const subscriptionCoupon = await Coupon("loyal-customer", {
 *   id: "LOYAL15",
 *   duration: "repeating",
 *   durationInMonths: 6,
 *   percentOff: 15,
 *   name: "Loyal Customer 15% Off",
 *   metadata: {
 *     type: "loyalty",
 *     tier: "premium"
 *   }
 * });
 */
export const Coupon = Resource(
  "stripe::Coupon",
  async function (
    this: Context<Coupon>,
    _id: string,
    props: CouponProps,
  ): Promise<Coupon> {
    const stripe = createStripeClient({ apiKey: props.apiKey });

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.coupons.del(this.output.id);
        }
      } catch (error) {
        handleStripeDeleteError(error, "Coupon", this.output?.id);
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

        try {
          try {
            coupon = await stripe.coupons.create(createParams);
          } catch (error) {
            if (isStripeConflictError(error) && props.adopt) {
              if (props.id) {
                const existingCoupon = await stripe.coupons.retrieve(props.id);
                const updateParams: Stripe.CouponUpdateParams = {
                  metadata: props.metadata,
                  name: props.name,
                };
                coupon = await stripe.coupons.update(
                  existingCoupon.id,
                  updateParams,
                );
              } else {
                throw error;
              }
            } else {
              throw error;
            }
          }
        } catch (error) {
          if (isStripeConflictError(error) && props.adopt) {
            if (props.id) {
              const existingCoupon = await stripe.coupons.retrieve(props.id);
              const updateParams: Stripe.CouponUpdateParams = {
                metadata: props.metadata,
                name: props.name,
              };
              coupon = await stripe.coupons.update(
                existingCoupon.id,
                updateParams,
              );
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
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
      logger.error("Error creating/updating coupon:", error);
      throw error;
    }
  },
);
