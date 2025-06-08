import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { handleApiError } from "./api-error.ts";
import { type CloudflareApiOptions, createCloudflareApi } from "./api.ts";
import type { CloudflareResponse } from "./response.ts";

/**
 * Cloudflare Email Address response format
 */
interface CloudflareEmailAddress {
  email: string;
  verified: boolean;
  created: string;
  modified: string;
  tag: string;
}

/**
 * Properties for creating an email destination address
 */
export interface EmailAddressProps extends CloudflareApiOptions {
  /**
   * Destination email address for routing
   */
  email: string;

  /**
   * Whether to automatically verify the email address if possible
   * Note: Verification typically requires email confirmation by the recipient
   *
   * @default false
   */
  verified?: boolean;
}

/**
 * A destination email address for Cloudflare email routing
 */
export interface EmailAddress extends Resource<"cloudflare::EmailAddress"> {
  /**
   * The email address
   */
  email: string;

  /**
   * Whether the email address has been verified
   */
  verified: boolean;

  /**
   * When the email address was created
   */
  created: string;

  /**
   * When the email address was last modified
   */
  modified: string;

  /**
   * Email address tag
   */
  tag: string;
}

/**
 * Manages destination email addresses for Cloudflare email routing.
 * These addresses can be used as targets in email routing rules.
 *
 * @example
 * ## Add a destination email address
 *
 * Add an email address that can receive routed emails.
 *
 * ```ts
 * const emailAddress = await EmailAddress("admin-email", {
 *   email: "admin@company.com"
 * });
 *
 * // Note: The email address will need to be verified before it can receive emails
 * console.log(`Verified: ${emailAddress.verified}`);
 * ```
 *
 * @example
 * ## Add multiple destination addresses
 *
 * Create multiple destination addresses for different routing purposes.
 *
 * ```ts
 * const supportEmail = await EmailAddress("support-email", {
 *   email: "support@company.com"
 * });
 *
 * const salesEmail = await EmailAddress("sales-email", {
 *   email: "sales@company.com"
 * });
 * ```
 */
export const EmailAddress = Resource(
  "cloudflare::EmailAddress",
  async function (
    this: Context<EmailAddress>,
    _id: string,
    props: EmailAddressProps,
  ): Promise<EmailAddress> {
    const api = await createCloudflareApi(props);

    if (this.phase === "delete") {
      if (this.output?.email) {
        const response = await api.delete(
          `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(this.output.email)}`,
        );
        if (!response.ok && response.status !== 404) {
          await handleApiError(response, "delete", "email address");
        }
      }
      return this.destroy();
    }

    if (this.phase === "update" && this.output) {
      // Email addresses cannot be updated, only created or deleted
      // If the email changed, we need to delete the old one and create a new one
      if (this.output.email !== props.email) {
        // Delete the old email address
        const deleteResponse = await api.delete(
          `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(this.output.email)}`,
        );
        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          await handleApiError(deleteResponse, "delete", "old email address");
        }

        // Create the new email address (fall through to create logic)
      } else {
        // Get current state
        const getResponse = await api.get(
          `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(props.email)}`,
        );
        if (!getResponse.ok) {
          if (getResponse.status === 404) {
            // Email address was deleted externally, recreate it
          } else {
            await handleApiError(getResponse, "get", "email address");
          }
        } else {
          const result =
            (await getResponse.json()) as CloudflareResponse<CloudflareEmailAddress>;

          return this({
            email: result.result.email,
            verified: result.result.verified,
            created: result.result.created,
            modified: result.result.modified,
            tag: result.result.tag,
          });
        }
      }
    }

    // Check if email address already exists
    const getResponse = await api.get(
      `/accounts/${api.accountId}/email/routing/addresses/${encodeURIComponent(props.email)}`,
    );

    if (getResponse.ok) {
      // Email address already exists, return it
      const result =
        (await getResponse.json()) as CloudflareResponse<CloudflareEmailAddress>;

      return this({
        email: result.result.email,
        verified: result.result.verified,
        created: result.result.created,
        modified: result.result.modified,
        tag: result.result.tag,
      });
    }

    // Create new email address
    const createPayload = {
      email: props.email,
    };

    const createResponse = await api.post(
      `/accounts/${api.accountId}/email/routing/addresses`,
      createPayload,
    );

    if (!createResponse.ok) {
      await handleApiError(createResponse, "create", "email address");
    }

    const result =
      (await createResponse.json()) as CloudflareResponse<CloudflareEmailAddress>;

    return this({
      email: result.result.email,
      verified: result.result.verified,
      created: result.result.created,
      modified: result.result.modified,
      tag: result.result.tag,
    });
  },
);
