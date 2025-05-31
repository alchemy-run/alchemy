import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface CardProps {
  customer: string;
  source?: string;
  number?: string;
  expMonth?: number;
  expYear?: number;
  cvc?: string;
  name?: string;
  addressCity?: string;
  addressCountry?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressState?: string;
  addressZip?: string;
  currency?: string;
  defaultForCurrency?: boolean;
  metadata?: Record<string, string>;
}

export interface Card extends Resource<"stripe::Card">, CardProps {
  id: string;
  object: "card";
  brand: string;
  country?: string;
  dynamicLast4?: string;
  fingerprint?: string;
  funding: string;
  last4: string;
  tokenizationMethod?: string;
}

export const Card = Resource(
  "stripe::Card",
  async function (
    this: Context<Card>,
    _id: string,
    props: CardProps,
  ): Promise<Card> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id && this.output?.customer) {
          await stripe.customers.deleteSource(
            this.output.customer,
            this.output.id,
          );
        }
      } catch (error) {
        console.error("Error deleting card:", error);
      }
      return this.destroy();
    }

    try {
      let card: Stripe.Card;

      if (this.phase === "update" && this.output?.id) {
        const updateParams: any = {};
        if (props.name !== undefined) updateParams.name = props.name;
        if (props.addressCity !== undefined)
          updateParams.address_city = props.addressCity;
        if (props.addressCountry !== undefined)
          updateParams.address_country = props.addressCountry;
        if (props.addressLine1 !== undefined)
          updateParams.address_line1 = props.addressLine1;
        if (props.addressLine2 !== undefined)
          updateParams.address_line2 = props.addressLine2;
        if (props.addressState !== undefined)
          updateParams.address_state = props.addressState;
        if (props.addressZip !== undefined)
          updateParams.address_zip = props.addressZip;
        if (props.expMonth !== undefined)
          updateParams.exp_month = props.expMonth;
        if (props.expYear !== undefined) updateParams.exp_year = props.expYear;
        if (props.metadata !== undefined)
          updateParams.metadata = props.metadata;

        card = (await stripe.customers.updateSource(
          props.customer,
          this.output.id,
          updateParams,
        )) as Stripe.Card;
      } else {
        const createParams: any = {
          metadata: props.metadata,
        };

        if (props.source) {
          createParams.source = props.source;
        } else if (props.number) {
          createParams.source = {
            object: "card",
            number: props.number,
            exp_month: props.expMonth,
            exp_year: props.expYear,
            cvc: props.cvc,
            name: props.name,
            address_city: props.addressCity,
            address_country: props.addressCountry,
            address_line1: props.addressLine1,
            address_line2: props.addressLine2,
            address_state: props.addressState,
            address_zip: props.addressZip,
            currency: props.currency,
            default_for_currency: props.defaultForCurrency,
          };
        }

        card = (await stripe.customers.createSource(
          props.customer,
          createParams,
        )) as Stripe.Card;
      }

      return this({
        id: card.id,
        object: card.object,
        customer: props.customer,
        brand: card.brand,
        country: card.country || undefined,
        dynamicLast4: card.dynamic_last4 || undefined,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        fingerprint: card.fingerprint || undefined,
        funding: card.funding,
        last4: card.last4,
        name: card.name || undefined,
        addressCity: card.address_city || undefined,
        addressCountry: card.address_country || undefined,
        addressLine1: card.address_line1 || undefined,
        addressLine2: card.address_line2 || undefined,
        addressState: card.address_state || undefined,
        addressZip: card.address_zip || undefined,
        currency: card.currency || undefined,
        defaultForCurrency: card.default_for_currency || undefined,
        metadata: card.metadata || undefined,
        tokenizationMethod: card.tokenization_method || undefined,
      });
    } catch (error) {
      console.error("Error creating/updating card:", error);
      throw error;
    }
  },
);
