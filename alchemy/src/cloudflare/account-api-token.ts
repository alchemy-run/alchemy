import { alchemy } from "../alchemy";
import type { Context } from "../context";
import { Resource } from "../resource";
import { Secret } from "../secret";
import { sha256 } from "../util/sha256";
import { createCloudflareApi, type CloudflareApiOptions } from "./api";

/**
 * Permission group for a token policy
 */
export interface TokenPolicyPermissionGroup {
  /**
   * ID of the permission group
   */
  id: string;

  /**
   * Optional metadata for the permission group
   */
  meta?: Record<string, any>;
}

/**
 * Policy that defines what the token can access
 */
export interface TokenPolicy {
  /**
   * Effect of the policy
   */
  effect: "allow" | "deny";

  /**
   * Permission groups to include in the policy
   */
  permissionGroups: TokenPolicyPermissionGroup[];

  /**
   * Resources the policy applies to
   */
  resources: Record<string, string>;
}

/**
 * Condition for token usage (e.g., IP restrictions)
 */
export interface TokenCondition {
  /**
   * IP address conditions
   */
  requestIp?: {
    /**
     * IP ranges to allow
     */
    in?: string[];

    /**
     * IP ranges to deny
     */
    notIn?: string[];
  };
}

/**
 * Properties for creating or updating an Account API Token
 */
export interface AccountApiTokenProps extends CloudflareApiOptions {
  /**
   * Name of the token
   */
  name: string;

  /**
   * Policies that define what the token can access
   */
  policies: TokenPolicy[];

  /**
   * Optional expiration date for the token (ISO format)
   */
  expiresOn?: string;

  /**
   * Optional "not before" date (token is not valid before this date) (ISO format)
   */
  notBefore?: string;

  /**
   * Optional conditions for token use (like IP restrictions)
   */
  condition?: TokenCondition;
}

/**
 * Cloudflare API token format as returned by the API
 */
interface CloudflareApiToken {
  id: string;
  name: string;
  status: string;
  policies: {
    effect: "allow" | "deny";
    permission_groups: {
      id: string;
      meta: Record<string, any>;
    }[];
    resources: Record<string, string>;
  }[];
  expires_on?: string;
  not_before?: string;
  condition?: {
    request_ip?: {
      in?: string[];
      not_in?: string[];
    };
  };
  value?: string;
}

/**
 * Output returned after Account API Token creation/update
 */
export interface AccountApiToken
  extends Resource<"cloudflare::AccountApiToken">,
    AccountApiTokenProps {
  /**
   * The ID of the token
   *
   * Equiv. to ACCESS_KEY_ID
   */
  id: string;

  /**
   * Status of the token
   */
  status: string;

  /**
   * Actual token value (only available on creation)
   * Stored as a Secret for security
   *
   * Equiv. to SECRET_ACCESS_KEY
   */
  value?: Secret;

  /**
   * Access key ID for the token
   *
   * An alias of {@link id}
   */
  accessKeyId: string;

  /**
   * Secret access key for the token
   *
   * The SHA-256 hash of the token {@link value}
   *
   * @see https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token
   */
  secretAccessKey: string;
}

/**
 * Creates a Cloudflare Account API Token with specified permissions.
 *
 * Note: Requires a Cloudflare API Key or Token with admin-level account access.
 * The OAuth token from `wrangler login` is NOT sufficient for this operation.
 * You must use an API token with permission to manage account API tokens.
 *
 * @see https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
 *
 * @example
 * // First, fetch all permission groups
 * const permissions = await PermissionGroups("cloudflare-permissions", {
 *   accountId: cfAccountId,
 * });
 *
 * // Create a token with read-only permissions for specific zones
 * const readOnlyToken = await AccountApiToken("readonly-token", {
 *   name: "Readonly Zone Token",
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: [
 *         { id: permissions["Zone Read"].id },
 *         { id: permissions["Analytics Read"].id }
 *       ],
 *       resources: {
 *         "com.cloudflare.api.account.zone.22b1de5f1c0e4b3ea97bb1e963b06a43": "*",
 *         "com.cloudflare.api.account.zone.eb78d65290b24279ba6f44721b3ea3c4": "*"
 *       }
 *     }
 *   ],
 *   expiresOn: "2024-12-31T23:59:59Z"
 * });
 *
 * @example
 * // Create a token with time and IP restrictions
 * const restrictedToken = await AccountApiToken("restricted-token", {
 *   name: "Restricted Access Token",
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: [
 *         { id: permissions["Worker Routes Edit"].id }
 *       ],
 *       resources: {
 *         "com.cloudflare.api.account.worker.route.*": "*"
 *       }
 *     }
 *   ],
 *   notBefore: "2023-01-01T00:00:00Z",
 *   expiresOn: "2023-12-31T23:59:59Z",
 *   condition: {
 *     requestIp: {
 *       in: ["192.168.1.0/24", "10.0.0.0/8"],
 *       notIn: ["192.168.1.100/32"]
 *     }
 *   }
 * });
 */
export const AccountApiToken = Resource(
  "cloudflare::AccountApiToken",
  async function (
    this: Context<AccountApiToken>,
    id: string,
    props: AccountApiTokenProps
  ): Promise<AccountApiToken> {
    // Create Cloudflare API client with automatic account discovery
    const api = await createCloudflareApi(props);

    if (this.phase === "delete") {
      // Delete token if we have an ID
      if (this.output?.id) {
        try {
          const deleteResponse = await api.delete(
            `/accounts/${api.accountId}/tokens/${this.output.id}`
          );

          if (!deleteResponse.ok && deleteResponse.status !== 404) {
            const errorData: any = await deleteResponse.json().catch(() => ({
              errors: [{ message: deleteResponse.statusText }],
            }));
            console.error(`Error deleting token '${props.name}':`, errorData);
          }
        } catch (error) {
          console.error(`Error deleting token '${props.name}':`, error);
        }
      }

      // Return destroyed state
      return this.destroy();
    }

    // Transform our properties to API format
    const apiPayload = {
      name: props.name,
      policies: props.policies.map((policy) => ({
        effect: policy.effect,
        permission_groups: policy.permissionGroups.map((pg) => ({
          id: pg.id,
          meta: pg.meta || {},
        })),
        resources: policy.resources,
      })),
      // Format dates for Cloudflare API (removing milliseconds)
      ...(props.expiresOn
        ? { expires_on: formatCloudflareDate(props.expiresOn) }
        : {}),
      ...(props.notBefore
        ? { not_before: formatCloudflareDate(props.notBefore) }
        : {}),
      ...(props.condition
        ? {
            condition: {
              request_ip: props.condition.requestIp
                ? {
                    in: props.condition.requestIp.in || [],
                    not_in: props.condition.requestIp.notIn || [],
                  }
                : undefined,
            },
          }
        : {}),
    };

    /**
     * Formats a date string for Cloudflare API by removing milliseconds
     * Converts from "2023-01-01T00:00:00.000Z" to "2023-01-01T00:00:00Z"
     */
    function formatCloudflareDate(dateStr: string): string {
      return dateStr.replace(/\.\d{3}Z$/, "Z");
    }

    let response;
    let tokenValue;

    if (this.phase === "update" && this.output?.id) {
      // Update existing token
      response = await api.put(
        `/accounts/${api.accountId}/tokens/${this.output.id}`,
        apiPayload
      );
    } else {
      // Create new token
      response = await api.post(
        `/accounts/${api.accountId}/tokens`,
        apiPayload
      );
    }

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({
        errors: [{ message: response.statusText }],
      }));

      throw new Error(
        `Error ${this.phase === "update" ? "updating" : "creating"} token '${props.name}': ${
          errorData.errors?.[0]?.message || response.statusText
        }`
      );
    }

    const result: { result: CloudflareApiToken } = await response.json();
    const tokenData = result.result;

    if (tokenData.value) {
      tokenValue = alchemy.secret(tokenData.value);
    } else {
      if (!this.output?.value) {
        throw new Error(
          `Token '${props.name}' was created but we have no record of its value. Try deleting and recreating the token.`
        );
      }
      tokenValue = this.output?.value;
    }

    // Transform API response to our format
    return this({
      id: tokenData.id,
      name: tokenData.name,
      status: tokenData.status,
      policies: tokenData.policies.map((policy) => ({
        effect: policy.effect,
        permissionGroups: policy.permission_groups.map((pg) => ({
          id: pg.id,
          meta: pg.meta,
        })),
        resources: policy.resources,
      })),
      ...(tokenData.expires_on ? { expiresOn: tokenData.expires_on } : {}),
      ...(tokenData.not_before ? { notBefore: tokenData.not_before } : {}),
      ...(tokenData.condition
        ? {
            condition: {
              requestIp: tokenData.condition.request_ip
                ? {
                    in: tokenData.condition.request_ip.in || [],
                    notIn: tokenData.condition.request_ip.not_in || [],
                  }
                : undefined,
            },
          }
        : {}),
      value: tokenValue,
      accessKeyId: tokenData.id,
      secretAccessKey: sha256(tokenValue.unencrypted),
    });
  }
);
