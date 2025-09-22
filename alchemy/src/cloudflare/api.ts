import type { Secret } from "../secret.ts";
import { withExponentialBackoff } from "../util/retry.ts";
import { safeFetch } from "../util/safe-fetch.ts";
import {
  getCloudflareAuthHeaders,
  normalizeAuthOptions,
  type CloudflareAuthOptions,
} from "./auth.ts";
import { getCloudflareAccountId } from "./user.ts";

/**
 * Options for Cloudflare API requests
 */
export interface CloudflareApiOptions {
  /**
   * Base URL for Cloudflare API
   *
   * @default https://api.cloudflare.com/client/v4
   */
  baseUrl?: string;

  /**
   * API Key to use (overrides CLOUDFLARE_API_KEY env var)
   */
  apiKey?: Secret;

  /**
   * API Token to use (overrides CLOUDFLARE_API_TOKEN env var)
   */
  apiToken?: Secret;

  /**
   * Account ID to use (overrides CLOUDFLARE_ACCOUNT_ID env var)
   * If not provided, will be automatically retrieved from the Cloudflare API
   */
  accountId?: string;

  /**
   * Email to use with API Key authentication
   * If not provided, will attempt to discover from Cloudflare API
   */
  email?: string;
}

/** Used to propagate normalized auth options from a parent resource to `createCloudflareApi` in a child resource */
export type InternalCloudflareApiOptions = CloudflareAuthOptions & {
  baseUrl?: string;
  accountId: string;
};

function computeCacheKey(options: CloudflareApiOptions): string {
  return `${options.baseUrl}|${options.accountId}|${options.apiKey?.unencrypted}|${options.apiToken?.unencrypted}|${options.email}`;
}

const cloudflareApiCache: Record<string, CloudflareApi> = {};

/**
 * Creates a CloudflareApi instance with automatic account ID discovery if not provided
 *
 * @param options API options
 * @returns Promise resolving to a CloudflareApi instance
 */
export async function createCloudflareApi(
  options: Partial<CloudflareApiOptions> | InternalCloudflareApiOptions = {},
): Promise<CloudflareApi> {
  // TODO: Implement scope-level credential resolution similar to AWS
  // This function should check for scope.providerCredentials.cloudflare
  // and merge those credentials with the provided options, following
  // the same three-tier resolution pattern: global → scope → resource
  const cacheKey = computeCacheKey(options);
  if (cloudflareApiCache[cacheKey]) {
    return cloudflareApiCache[cacheKey];
  }

  const authOptions = await normalizeAuthOptions(options);
  const accountId =
    options.accountId ??
    process.env.CLOUDFLARE_ACCOUNT_ID ??
    process.env.CF_ACCOUNT_ID ??
    (await getCloudflareAccountId(authOptions));
  return (cloudflareApiCache[cacheKey] = new CloudflareApi({
    baseUrl: options.baseUrl,
    accountId,
    authOptions,
  }));
}

/**
 * Cloudflare API client using raw fetch
 */
export class CloudflareApi {
  public readonly accountId: string;
  public readonly baseUrl: string;
  public readonly authOptions: CloudflareAuthOptions;

  /**
   * Create a new Cloudflare API client
   * Use createCloudflareApi factory function instead of direct constructor
   * for automatic account ID discovery.
   *
   * @param options API options
   */
  constructor(options: {
    baseUrl?: string;
    accountId: string;
    authOptions: CloudflareAuthOptions;
  }) {
    this.accountId = options.accountId;
    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
    this.authOptions = options.authOptions;
  }

  /**
   * Make a fetch request to the Cloudflare API
   *
   * @param path API path (without base URL)
   * @param init Fetch init options
   * @returns Raw Response object from fetch
   */
  public async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (init.headers) {
      headers = init.headers;
    }
    headers = {
      ...(await getCloudflareAuthHeaders(this.authOptions)),
      ...headers,
    };

    // TODO(sam): is this necessary?
    if (init.body instanceof FormData) {
      delete headers["Content-Type"];
    }

    let forbidden = false;

    // Use withExponentialBackoff for automatic retry on network errors
    return withExponentialBackoff(
      async () => {
        const response = await safeFetch(`${this.baseUrl}${path}`, {
          ...init,
          headers,
        });
        if (response.status.toString().startsWith("5")) {
          throw new InternalError(response.statusText);
        }
        if (response.status === 403 && !forbidden) {
          // we occasionally get 403s from Cloudflare tha tare actually transient
          // so, we will retry this at MOST once
          forbidden = true;
          throw new ForbiddenError();
        }
        if (response.status === 429) {
          const data: any = await response.json();
          throw new TooManyRequestsError(
            data.errors[0].message ?? response.statusText,
          );
        }
        return response;
      },
      // transient errors should be retried aggressively
      (error) =>
        error instanceof InternalError ||
        error instanceof TooManyRequestsError ||
        error instanceof ForbiddenError ||
        error.code === "ECONNRESET",
      10, // Maximum 10 attempts (1 initial + 9 retries)
      1000, // Start with 1s delay, will exponentially increase
    );
  }

  /**
   * Helper for GET requests
   */
  async get(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "GET" });
  }

  /**
   * Helper for HEAD requests
   */
  async head(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "HEAD" });
  }
  /**
   * Helper for POST requests
   */
  async post(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.fetch(path, {
      ...init,
      method: "POST",
      body: this.toBody(body),
    });
  }

  /**
   * Helper for PUT requests
   */
  async put(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.fetch(path, {
      ...init,
      method: "PUT",
      body: this.toBody(body),
    });
  }

  toBody(body: BodyInit): BodyInit {
    return body instanceof FormData
      ? body
      : typeof body === "string"
        ? body
        : body instanceof ReadableStream
          ? body
          : JSON.stringify(body);
  }

  /**
   * Helper for PATCH requests
   */
  async patch(
    path: string,
    body: any,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.fetch(path, {
      ...init,
      method: "PATCH",
      body: this.toBody(body),
    });
  }

  /**
   * Helper for DELETE requests
   */
  async delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "DELETE" });
  }
}

class InternalError extends Error {}

class TooManyRequestsError extends Error {
  constructor(message: string) {
    super(
      `Cloudflare Rate Limit Exceeded at ${new Date().toISOString()}: ${message}`,
    );
  }
}

class ForbiddenError extends Error {}
/**
 * Cloudflare scope extensions - adds Cloudflare credential support to scope options.
 * This uses TypeScript module augmentation to extend the ProviderCredentials interface.
 * Since ScopeOptions and RunOptions both extend ProviderCredentials,
 * they automatically inherit these properties.
 *
 * NOTE: These scope credentials are not currently being used by createCloudflareApi.
 * See TODO above in createCloudflareApi function for implementation needed.
 */
declare module "../scope.ts" {
  interface ProviderCredentials {
    /**
     * Cloudflare credentials configuration for this scope.
     * All Cloudflare resources created within this scope will inherit these credentials
     * unless overridden at the resource level.
     */
    cloudflare?: CloudflareApiOptions;
  }
}
