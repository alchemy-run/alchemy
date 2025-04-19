import type { Secret } from "../secret";
import { withExponentialBackoff } from "../util/retry";
import { getCloudflareAuthHeaders, getCloudflareUserInfo } from "./auth";

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
   * Zone ID to use (overrides CLOUDFLARE_ZONE_ID env var)
   */
  zoneId?: string;

  /**
   * Email to use with API Key authentication
   * If not provided, will attempt to discover from Cloudflare API
   */
  email?: string;
}

/**
 * Creates a CloudflareApi instance with automatic account ID discovery if not provided
 *
 * @param options API options
 * @returns Promise resolving to a CloudflareApi instance
 */
export async function createCloudflareApi(
  options: Partial<CloudflareApiOptions> = {}
): Promise<CloudflareApi> {
  const userInfo = await getCloudflareUserInfo(options);
  return new CloudflareApi({
    baseUrl: options.baseUrl,
    accountId: options.accountId ?? userInfo.accounts[0].id!,
    email: userInfo.email!,
    apiKey: userInfo.apiKey,
    apiToken: userInfo.apiToken,
    zoneId: options.zoneId,
  });
}

/**
 * Cloudflare API client using raw fetch
 */
export class CloudflareApi {
  public readonly accountId: string;
  public readonly baseUrl: string;
  /**
   * Create a new Cloudflare API client
   * Use createCloudflareApi factory function instead of direct constructor
   * for automatic account ID discovery.
   *
   * @param options API options
   */
  constructor(
    private readonly options: CloudflareApiOptions & {
      accountId: string;
    }
  ) {
    this.accountId = options.accountId;
    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
  }

  /**
   * Make a fetch request to the Cloudflare API
   *
   * @param path API path (without base URL)
   * @param init Fetch init options
   * @returns Raw Response object from fetch
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
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
      ...(await getCloudflareAuthHeaders(this.options)),
      ...headers,
    };

    // TODO(sam): is this necessary?
    if (init.body instanceof FormData) {
      delete headers["Content-Type"];
    }

    // Use withExponentialBackoff for automatic retry on network errors
    return withExponentialBackoff(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers,
        }),
      (error) => {
        // Only retry on network-related errors
        const errorMsg = (error as Error).message || "";
        const isNetworkError =
          errorMsg.includes("socket connection was closed") ||
          errorMsg.includes("ECONNRESET") ||
          errorMsg.includes("ETIMEDOUT") ||
          errorMsg.includes("ECONNREFUSED");

        return isNetworkError;
      },
      5, // Maximum 5 attempts (1 initial + 4 retries)
      1000 // Start with 1s delay, will exponentially increase
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
    init: RequestInit = {}
  ): Promise<Response> {
    const requestBody =
      body instanceof FormData
        ? body
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    return this.fetch(path, { ...init, method: "POST", body: requestBody });
  }

  /**
   * Helper for PUT requests
   */
  async put(
    path: string,
    body: any,
    init: RequestInit = {}
  ): Promise<Response> {
    const requestBody = body instanceof FormData ? body : JSON.stringify(body);
    return this.fetch(path, { ...init, method: "PUT", body: requestBody });
  }

  /**
   * Helper for PATCH requests
   */
  async patch(
    path: string,
    body: any,
    init: RequestInit = {}
  ): Promise<Response> {
    return this.fetch(path, {
      ...init,
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  /**
   * Helper for DELETE requests
   */
  async delete(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetch(path, { ...init, method: "DELETE" });
  }
}
