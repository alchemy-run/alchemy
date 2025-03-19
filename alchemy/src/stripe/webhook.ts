import Stripe from "stripe";
import type { Context } from "../resource";
import { Resource } from "../resource";

export type EnabledEvent = Stripe.WebhookEndpointUpdateParams.EnabledEvent;

/**
 * Properties for creating a Stripe webhook endpoint
 */
export interface WebhookEndpointProps {
  /**
   * The URL of the webhook endpoint
   */
  url: string;

  /**
   * The list of events to enable for this endpoint
   */
  enabledEvents: EnabledEvent[];

  /**
   * Description of the webhook
   */
  description?: string;

  /**
   * Whether the webhook is active
   */
  active?: boolean;

  /**
   * The API version events are rendered as for this webhook
   */
  apiVersion?: string;

  /**
   * Whether to include mounted endpoint events automatically
   */
  connect?: boolean;

  /**
   * Webhook endpoint metadata
   */
  metadata?: Record<string, string>;
}

/**
 * Output from the Stripe webhook endpoint
 */
export interface WebhookEndpointOutput extends WebhookEndpointProps {
  /**
   * The ID of the webhook
   */
  id: string;

  /**
   * The webhook endpoint's secret key, used to verify signatures on received events
   */
  secret: string;

  /**
   * The webhook endpoint's application
   */
  application?: string;

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
   * The status of the webhook
   */
  status: string;
}

export class WebhookEndpoint extends Resource(
  "stripe::WebhookEndpoint",
  async (ctx: Context<WebhookEndpointOutput>, props: WebhookEndpointProps) => {
    // Get Stripe API key from context or environment
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }

    // Initialize Stripe client
    const stripe = new Stripe(apiKey);

    if (ctx.event === "delete") {
      try {
        // Get the webhook ID from the stored output
        if (ctx.event === "delete" && ctx.output?.id) {
          await stripe.webhookEndpoints.del(ctx.output.id);
        }
      } catch (error) {
        // Ignore if the webhook doesn't exist
        console.error("Error deleting webhook:", error);
      }

      // Return a minimal output for deleted state
      return {
        ...props,
        id: "",
        secret: "",
        createdAt: 0,
        updatedAt: 0,
        livemode: false,
        status: "deleted",
      };
    } else {
      try {
        let webhook: Stripe.WebhookEndpoint;

        if (ctx.event === "update" && ctx.output?.id) {
          // Update existing webhook
          webhook = await stripe.webhookEndpoints.update(ctx.output.id, {
            url: props.url,
            enabled_events: props.enabledEvents,
            description: props.description,
            disabled: props.active === false,
            metadata: props.metadata,
          });
        } else {
          // Create new webhook
          webhook = await stripe.webhookEndpoints.create({
            url: props.url,
            enabled_events: props.enabledEvents,
            description: props.description,
            metadata: props.metadata,
          });

          // For connect parameter, need to handle it separately if it exists
          if (props.connect !== undefined) {
            // Note: connect is specified at creation time and cannot be updated
            console.log(
              "Note: 'connect' parameter will be applied at creation time only",
            );
          }
        }

        // Store the secret if available
        let secret = "";
        if (webhook.secret) {
          secret = webhook.secret;
        } else if (ctx.event === "update" && ctx.output?.secret) {
          secret = ctx.output.secret;
        }

        // Map Stripe API response to our output format
        const output: WebhookEndpointOutput = {
          id: webhook.id,
          url: webhook.url,
          enabledEvents: webhook.enabled_events as EnabledEvent[],
          description: webhook.description || undefined,
          active: webhook.status === "enabled",
          apiVersion: webhook.api_version || undefined,
          // connect: !!webhook.connect,
          metadata: webhook.metadata || undefined,
          secret: secret,
          application: webhook.application || undefined,
          createdAt: webhook.created,
          livemode: webhook.livemode,
          updatedAt: webhook.created, // Using created timestamp as updated
          status: webhook.status,
        };

        return output;
      } catch (error) {
        console.error("Error creating/updating webhook:", error);
        throw error;
      }
    }
  },
) {}
