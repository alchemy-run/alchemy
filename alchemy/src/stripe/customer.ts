import Stripe from "stripe";
import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";

export interface CustomerAddress {
  city?: string;
  country?: string;
  line1?: string;
  line2?: string;
  postalCode?: string;
  state?: string;
}

export interface CustomerShipping {
  address?: CustomerAddress;
  name?: string;
  phone?: string;
}

export interface CustomerInvoiceSettings {
  customFields?: Array<{
    name: string;
    value: string;
  }>;
  defaultPaymentMethod?: string;
  footer?: string;
  renderingOptions?: {
    amountTaxDisplay?: Stripe.CustomerCreateParams.InvoiceSettings.RenderingOptions.AmountTaxDisplay;
  };
}

export interface CustomerProps {
  address?: CustomerAddress;
  balance?: number;
  coupon?: string;
  description?: string;
  email?: string;
  invoicePrefix?: string;
  invoiceSettings?: CustomerInvoiceSettings;
  metadata?: Record<string, string>;
  name?: string;
  nextInvoiceSequence?: number;
  paymentMethod?: string;
  phone?: string;
  preferredLocales?: string[];
  promotionCode?: string;
  shipping?: CustomerShipping;
  source?: string;
  taxExempt?: Stripe.CustomerCreateParams.TaxExempt;
  testClock?: string;
}

export interface Customer extends Resource<"stripe::Customer">, CustomerProps {
  id: string;
  object: "customer";
  created: number;
  currency?: string;
  defaultSource?: string;
  delinquent?: boolean;
  discount?: any;
  livemode: boolean;
  sources?: any;
  subscriptions?: any;
  taxIds?: any;
}

export const Customer = Resource(
  "stripe::Customer",
  async function (
    this: Context<Customer>,
    _id: string,
    props: CustomerProps,
  ): Promise<Customer> {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    const stripe = new Stripe(apiKey);

    if (this.phase === "delete") {
      try {
        if (this.output?.id) {
          await stripe.customers.del(this.output.id);
        }
      } catch (error) {
        console.error("Error deleting customer:", error);
      }
      return this.destroy();
    }

    try {
      let customer: Stripe.Customer;

      if (this.phase === "update" && this.output?.id) {
        const updateParams: Stripe.CustomerUpdateParams = {
          address: props.address
            ? {
                city: props.address.city,
                country: props.address.country,
                line1: props.address.line1,
                line2: props.address.line2,
                postal_code: props.address.postalCode,
                state: props.address.state,
              }
            : undefined,
          balance: props.balance,
          coupon: props.coupon,
          description: props.description,
          email: props.email,
          invoice_prefix: props.invoicePrefix,
          metadata: props.metadata,
          name: props.name,
          next_invoice_sequence: props.nextInvoiceSequence,
          phone: props.phone,
          preferred_locales: props.preferredLocales,
          promotion_code: props.promotionCode,
          shipping: props.shipping as any,
          source: props.source,
          tax_exempt: props.taxExempt,
        };

        if (props.invoiceSettings) {
          updateParams.invoice_settings = {
            custom_fields: props.invoiceSettings.customFields,
            default_payment_method: props.invoiceSettings.defaultPaymentMethod,
            footer: props.invoiceSettings.footer,
            rendering_options: props.invoiceSettings.renderingOptions
              ? {
                  amount_tax_display:
                    props.invoiceSettings.renderingOptions.amountTaxDisplay,
                }
              : null,
          };
        }

        customer = await stripe.customers.update(this.output.id, updateParams);
      } else {
        const createParams: Stripe.CustomerCreateParams = {
          address: props.address
            ? {
                city: props.address.city,
                country: props.address.country,
                line1: props.address.line1,
                line2: props.address.line2,
                postal_code: props.address.postalCode,
                state: props.address.state,
              }
            : undefined,
          balance: props.balance,
          coupon: props.coupon,
          description: props.description,
          email: props.email,
          invoice_prefix: props.invoicePrefix,
          metadata: props.metadata,
          name: props.name,
          next_invoice_sequence: props.nextInvoiceSequence,
          payment_method: props.paymentMethod,
          phone: props.phone,
          preferred_locales: props.preferredLocales,
          promotion_code: props.promotionCode,
          shipping: props.shipping as any,
          source: props.source,
          tax_exempt: props.taxExempt,
          test_clock: props.testClock,
        };

        if (props.invoiceSettings) {
          createParams.invoice_settings = {
            custom_fields: props.invoiceSettings.customFields,
            default_payment_method: props.invoiceSettings.defaultPaymentMethod,
            footer: props.invoiceSettings.footer,
            rendering_options: props.invoiceSettings.renderingOptions
              ? {
                  amount_tax_display:
                    props.invoiceSettings.renderingOptions.amountTaxDisplay,
                }
              : null,
          };
        }

        customer = await stripe.customers.create(createParams);
      }

      return this({
        id: customer.id,
        object: customer.object,
        address: customer.address
          ? {
              city: customer.address.city || undefined,
              country: customer.address.country || undefined,
              line1: customer.address.line1 || undefined,
              line2: customer.address.line2 || undefined,
              postalCode: customer.address.postal_code || undefined,
              state: customer.address.state || undefined,
            }
          : undefined,
        balance: customer.balance || undefined,
        created: customer.created,
        currency: customer.currency || undefined,
        defaultSource:
          typeof customer.default_source === "string"
            ? customer.default_source
            : undefined,
        delinquent: customer.delinquent || undefined,
        description: customer.description || undefined,
        discount: customer.discount || undefined,
        email: customer.email || undefined,
        invoicePrefix: customer.invoice_prefix || undefined,
        invoiceSettings: customer.invoice_settings
          ? {
              customFields:
                customer.invoice_settings.custom_fields?.map((field) => ({
                  name: field.name,
                  value: field.value,
                })) || undefined,
              defaultPaymentMethod:
                typeof customer.invoice_settings.default_payment_method ===
                "string"
                  ? customer.invoice_settings.default_payment_method
                  : customer.invoice_settings.default_payment_method?.id ||
                    undefined,
              footer: customer.invoice_settings.footer || undefined,
              renderingOptions: customer.invoice_settings.rendering_options
                ? {
                    amountTaxDisplay: customer.invoice_settings
                      .rendering_options.amount_tax_display as any,
                  }
                : undefined,
            }
          : undefined,
        livemode: customer.livemode,
        metadata: customer.metadata || undefined,
        name: customer.name || undefined,
        nextInvoiceSequence: customer.next_invoice_sequence || undefined,
        phone: customer.phone || undefined,
        preferredLocales: customer.preferred_locales || undefined,
        shipping: customer.shipping
          ? {
              address: customer.shipping.address
                ? {
                    city: customer.shipping.address.city || undefined,
                    country: customer.shipping.address.country || undefined,
                    line1: customer.shipping.address.line1 || undefined,
                    line2: customer.shipping.address.line2 || undefined,
                    postalCode:
                      customer.shipping.address.postal_code || undefined,
                    state: customer.shipping.address.state || undefined,
                  }
                : undefined,
              name: customer.shipping.name || undefined,
              phone: customer.shipping.phone || undefined,
            }
          : undefined,
        sources: customer.sources || undefined,
        subscriptions: customer.subscriptions || undefined,
        taxExempt: customer.tax_exempt || undefined,
        taxIds: customer.tax_ids || undefined,
      });
    } catch (error) {
      console.error("Error creating/updating customer:", error);
      throw error;
    }
  },
);
