import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { logger } from "../util/logger.ts";
import { handleApiError } from "./api-error.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";
import type { CloudflareResponse } from "./response.ts";
import type { Zone } from "./zone.ts";

/**
 * Properties for creating or updating a RedirectRule
 */
export interface RedirectRuleProps extends CloudflareApiOptions {
  /**
   * The zone where the redirect rule will be applied
   * Can be a zone ID string or a Zone resource
   */
  zone: string | Zone;

  /**
   * For wildcard redirects: the URL pattern to match
   * Example: "https://*.example.com/files/*"
   * This is mutually exclusive with `expression`
   */
  requestUrl?: string;

  /**
   * For dynamic redirects: a Cloudflare Rules expression
   * Example: 'http.request.uri.path matches "/autodiscover\\.(xml|src)$"'
   * This is mutually exclusive with `requestUrl`
   * @see https://developers.cloudflare.com/ruleset-engine/rules-language/expressions/
   */
  expression?: string;

  /**
   * The target URL for the redirect
   * Can include placeholders like ${1}, ${2} for wildcard matches
   * Example: "https://example.com/${1}/files/${2}"
   */
  targetUrl: string;

  /**
   * HTTP status code for the redirect
   * @default 301
   */
  statusCode?: 301 | 302 | 303 | 307 | 308;

  /**
   * Whether to preserve query string parameters
   * @default true
   */
  preserveQueryString?: boolean;
}

/**
 * Cloudflare Ruleset response format
 */
interface CloudflareRuleset {
  id: string;
  name: string;
  description?: string;
  kind: string;
  version: string;
  rules: CloudflareRule[];
  last_updated: string;
  phase: string;
}

/**
 * Cloudflare Rule response format
 */
interface CloudflareRule {
  id: string;
  version: string;
  action: string;
  expression: string;
  description?: string;
  last_updated: string;
  ref: string;
  enabled: boolean;
  action_parameters?: {
    from_value?: {
      status_code?: number;
      target_url?: {
        value?: string;
        expression?: string;
      };
      preserve_query_string?: boolean;
    };
  };
}

/**
 * Output returned after RedirectRule creation/update
 */
export interface RedirectRule extends Resource<"cloudflare::RedirectRule"> {
  /**
   * The ID of the redirect rule
   */
  ruleId: string;

  /**
   * The ID of the ruleset containing this rule
   */
  rulesetId: string;

  /**
   * The zone ID where the rule is applied
   */
  zoneId: string;

  /**
   * The request URL pattern (for wildcard redirects)
   */
  requestUrl?: string;

  /**
   * The expression (for dynamic redirects)
   */
  expression?: string;

  /**
   * The target URL for the redirect
   */
  targetUrl: string;

  /**
   * HTTP status code for the redirect
   */
  statusCode: number;

  /**
   * Whether query string parameters are preserved
   */
  preserveQueryString: boolean;

  /**
   * Whether the rule is enabled
   */
  enabled: boolean;

  /**
   * Time when the rule was last updated
   */
  lastUpdated: string;
}

/**
 * A Cloudflare Redirect Rule enables URL redirects and rewrites using Cloudflare's Rules engine.
 * Supports wildcard redirects, static redirects, and dynamic redirects with expressions.
 *
 * @example
 * ## Wildcard Redirect
 *
 * Redirect from a wildcard pattern to a target URL with placeholders.
 *
 * ```ts
 * const wildcardRedirect = await RedirectRule("my-wildcard-redirect", {
 *   zone: "example.com",
 *   requestUrl: "https://*.example.com/files/*",
 *   targetUrl: "https://example.com/${1}/files/${2}",
 *   statusCode: 301,
 *   preserveQueryString: true
 * });
 * ```
 *
 * @example
 * ## Static Redirect
 *
 * Simple redirect from any request to a static target URL.
 *
 * ```ts
 * const staticRedirect = await RedirectRule("my-static-redirect", {
 *   zone: "example.com",
 *   targetUrl: "https://example.com/",
 *   statusCode: 301,
 *   preserveQueryString: true
 * });
 * ```
 *
 * @example
 * ## Dynamic Redirect with Expression
 *
 * Complex redirect using Cloudflare's Rules language for advanced matching.
 *
 * ```ts
 * const dynamicRedirect = await RedirectRule("my-dynamic-redirect", {
 *   zone: "example.com",
 *   expression: 'http.request.uri.path matches "/autodiscover\\.(xml|src)$"',
 *   targetUrl: "https://example.com/not-found",
 *   statusCode: 301,
 *   preserveQueryString: true
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/rules/url-forwarding/single-redirects/
 */
export const RedirectRule = Resource(
  "cloudflare::RedirectRule",
  async function (
    this: Context<RedirectRule>,
    _id: string,
    props: RedirectRuleProps,
  ): Promise<RedirectRule> {
    // Create Cloudflare API client
    const api = await createCloudflareApi(props);

    // Get zone ID
    const zoneId = typeof props.zone === "string" ? props.zone : props.zone.id;

    if (this.phase === "delete") {
      if (this.output?.ruleId && this.output?.rulesetId) {
        const deleteResponse = await api.delete(
          `/zones/${zoneId}/rulesets/${this.output.rulesetId}/rules/${this.output.ruleId}`,
        );

        if (!deleteResponse.ok && deleteResponse.status !== 404) {
          await handleApiError(
            deleteResponse,
            "delete",
            "redirect rule",
            this.output.ruleId,
          );
        }
      } else {
        logger.warn("Redirect rule not found, skipping delete");
      }
      return this.destroy();
    }

    // Validate props
    if (props.requestUrl && props.expression) {
      throw new Error(
        "Cannot specify both requestUrl and expression. Use requestUrl for wildcard redirects or expression for dynamic redirects.",
      );
    }

    const statusCode = props.statusCode ?? 301;
    const preserveQueryString = props.preserveQueryString ?? true;

    // Build the rule expression
    let ruleExpression: string;
    if (props.requestUrl) {
      // Convert wildcard URL to Cloudflare expression
      ruleExpression = convertWildcardUrlToExpression(props.requestUrl);
    } else if (props.expression) {
      ruleExpression = props.expression;
    } else {
      // Static redirect - match all requests
      ruleExpression = "true";
    }

    if (
      this.phase === "update" &&
      this.output?.ruleId &&
      this.output?.rulesetId
    ) {
      // Update existing rule
      const updateResponse = await api.patch(
        `/zones/${zoneId}/rulesets/${this.output.rulesetId}/rules/${this.output.ruleId}`,
        {
          action: "redirect",
          expression: ruleExpression,
          action_parameters: {
            from_value: {
              status_code: statusCode,
              target_url: {
                value: props.targetUrl,
              },
              preserve_query_string: preserveQueryString,
            },
          },
          enabled: true,
        },
      );

      if (!updateResponse.ok) {
        await handleApiError(
          updateResponse,
          "update",
          "redirect rule",
          this.output.ruleId,
        );
      }

      const updateResult =
        (await updateResponse.json()) as CloudflareResponse<CloudflareRule>;
      const updatedRule = updateResult.result;

      return this({
        ruleId: updatedRule.id,
        rulesetId: this.output.rulesetId,
        zoneId,
        requestUrl: props.requestUrl,
        expression: props.expression,
        targetUrl: props.targetUrl,
        statusCode,
        preserveQueryString,
        enabled: updatedRule.enabled,
        lastUpdated: updatedRule.last_updated,
      });
    }

    // Get or create the redirect ruleset for this zone
    const rulesetId = await getOrCreateRedirectRuleset(api, zoneId);

    // Create the rule
    const createResponse = await api.post(
      `/zones/${zoneId}/rulesets/${rulesetId}/rules`,
      {
        action: "redirect",
        expression: ruleExpression,
        action_parameters: {
          from_value: {
            status_code: statusCode,
            target_url: {
              value: props.targetUrl,
            },
            preserve_query_string: preserveQueryString,
          },
        },
        enabled: true,
      },
    );

    if (!createResponse.ok) {
      const errorBody = await createResponse.text();
      throw new Error(
        `Failed to create redirect rule: ${createResponse.statusText}\nResponse: ${errorBody}`,
      );
    }

    const createResult =
      (await createResponse.json()) as CloudflareResponse<CloudflareRule>;
    const createdRule = createResult.result;

    return this({
      ruleId: createdRule.id,
      rulesetId,
      zoneId,
      requestUrl: props.requestUrl,
      expression: props.expression,
      targetUrl: props.targetUrl,
      statusCode,
      preserveQueryString,
      enabled: createdRule.enabled,
      lastUpdated: createdRule.last_updated,
    });
  },
);

/**
 * Get or create the redirect ruleset for a zone
 */
async function getOrCreateRedirectRuleset(
  api: CloudflareApi,
  zoneId: string,
): Promise<string> {
  // First, try to get existing redirect ruleset
  const rulesetsResponse = await api.get(`/zones/${zoneId}/rulesets`);

  if (!rulesetsResponse.ok) {
    throw new Error(`Failed to get rulesets: ${rulesetsResponse.statusText}`);
  }

  const rulesetsResult = (await rulesetsResponse.json()) as CloudflareResponse<
    CloudflareRuleset[]
  >;
  const redirectRuleset = rulesetsResult.result.find(
    (ruleset) => ruleset.phase === "http_request_redirect",
  );

  if (redirectRuleset) {
    return redirectRuleset.id;
  }

  // Create new redirect ruleset
  const createRulesetResponse = await api.post(`/zones/${zoneId}/rulesets`, {
    name: "Zone-level redirect ruleset",
    description: "Redirect rules for the zone",
    kind: "zone",
    phase: "http_request_redirect",
  });

  if (!createRulesetResponse.ok) {
    throw new Error(
      `Failed to create redirect ruleset: ${createRulesetResponse.statusText}`,
    );
  }

  const createRulesetResult =
    (await createRulesetResponse.json()) as CloudflareResponse<CloudflareRuleset>;
  return createRulesetResult.result.id;
}

/**
 * Convert a wildcard URL pattern to a Cloudflare Rules expression
 */
function convertWildcardUrlToExpression(wildcardUrl: string): string {
  // Parse the URL to extract components
  const url = new URL(wildcardUrl);
  const hostname = url.hostname;
  const pathname = url.pathname;

  let expression = "";

  // Handle hostname wildcards
  if (hostname.includes("*")) {
    // Convert hostname wildcard to regex pattern
    const hostnamePattern = hostname
      .replace(/\./g, "\\.")
      .replace(/\*/g, "([^.]+)");
    expression += `http.request.uri.authority matches "^${hostnamePattern}$"`;
  } else {
    expression += `http.request.uri.authority == "${hostname}"`;
  }

  // Handle pathname wildcards
  if (pathname.includes("*")) {
    // Convert pathname wildcard to regex pattern
    const pathnamePattern = pathname
      .replace(/\./g, "\\.")
      .replace(/\*/g, "(.*)");
    expression += ` and http.request.uri.path matches "^${pathnamePattern}$"`;
  } else if (pathname !== "/") {
    expression += ` and http.request.uri.path == "${pathname}"`;
  }

  // Handle protocol
  if (url.protocol === "https:") {
    expression += " and ssl";
  } else if (url.protocol === "http:") {
    expression += " and not ssl";
  }

  return expression;
}
