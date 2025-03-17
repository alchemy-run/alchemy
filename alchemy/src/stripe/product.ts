import Stripe from "stripe";
import type { Context } from "../resource";
import { Resource } from "../resource";

type ProductType = Stripe.Product.Type;

/**
 * Properties for creating a Stripe product
 */
export interface ProductProps {
  /**
   * The product's name
   */
  name: string;

  /**
   * The product's description
   */
  description?: string;

  /**
   * Whether the product is active
   */
  active?: boolean;

  /**
   * A list of up to 8 URLs of images for this product
   */
  images?: string[];

  /**
   * A URL of the product's thumbnail
   */
  url?: string;

  /**
   * Whether this product is shipped (physical goods)
   */
  shippable?: boolean;

  /**
   * Product type: good, service
   */
  type?: ProductType;

  /**
   * Unit label to use on invoices
   */
  unitLabel?: string;

  /**
   * A label for the product to be displayed on Checkout
   */
  statementDescriptor?: string;

  /**
   * Set of key-value pairs for this product
   */
  metadata?: Record<string, string>;

  /**
   * Default tax code for the product
   */
  taxCode?: string;
}

/**
 * Output from the Stripe product
 */
export interface ProductOutput extends ProductProps {
  /**
   * The ID of the product
   */
  id: string;

  /**
   * Time at which the object was created
   */
  createdAt: number;

  /**
   * Has the value true if the object exists in live mode or the value false if the object exists in test mode
   */
  livemode: boolean;

  /**
   * Time at which the object was last updated
   */
  updatedAt: number;

  /**
   * Whether this product can be used for Checkout/Payment Links
   */
  packageDimensions?: {
    height: number;
    length: number;
    weight: number;
    width: number;
  };
}

export class Product extends Resource(
  "stripe::Product",
  async (ctx: Context<ProductOutput>, props: ProductProps) => {
    // Get Stripe API key from context or environment
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    // Initialize Stripe client
    const stripe = new Stripe(apiKey);

    if (ctx.event === "delete") {
      try {
        if (ctx.event === "delete" && ctx.output?.id) {
          await stripe.products.update(ctx.output.id, { active: false });
        }
      } catch (error) {
        // Ignore if the product doesn't exist
        console.error("Error deactivating product:", error);
      }

      // Return a minimal output for deleted state
      return {
        ...props,
        id: "",
        createdAt: 0,
        updatedAt: 0,
        livemode: false,
      };
    } else {
      try {
        let product: Stripe.Product;

        if (ctx.event === "update" && ctx.output?.id) {
          // Update existing product
          product = await stripe.products.update(ctx.output.id, {
            name: props.name,
            description: props.description,
            active: props.active,
            images: props.images,
            url: props.url,
            statement_descriptor: props.statementDescriptor,
            metadata: props.metadata,
            tax_code: props.taxCode,
          });
        } else {
          // Create new product
          product = await stripe.products.create({
            name: props.name,
            description: props.description,
            active: props.active,
            images: props.images,
            url: props.url,
            shippable: props.shippable,
            type: props.type as Stripe.ProductCreateParams.Type,
            unit_label: props.unitLabel,
            statement_descriptor: props.statementDescriptor,
            metadata: props.metadata,
            tax_code: props.taxCode,
          });
        }

        // Map Stripe API response to our output format
        const output: ProductOutput = {
          id: product.id,
          name: product.name,
          description: product.description || undefined,
          active: product.active,
          images: product.images || undefined,
          url: product.url || undefined,
          shippable: product.shippable || undefined,
          type: product.type as ProductType,
          unitLabel: product.unit_label || undefined,
          statementDescriptor: product.statement_descriptor || undefined,
          metadata: product.metadata || undefined,
          taxCode:
            typeof product.tax_code === "string" ? product.tax_code : undefined,
          createdAt: product.created,
          livemode: product.livemode,
          updatedAt: product.updated,
          packageDimensions: product.package_dimensions || undefined,
        };

        return output;
      } catch (error) {
        console.error("Error creating/updating product:", error);
        throw error;
      }
    }
  },
) {}
