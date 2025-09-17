import { Provider, type Credentials } from "../auth.ts";
import type { Secret } from "../secret.ts";
import { memoize } from "../util/memoize.ts";
import { withExponentialBackoff } from "../util/retry.ts";
import { safeFetch } from "../util/safe-fetch.ts";
import { CloudflareAuth } from "./auth.ts";
import { getCloudflareAccountId, getUserEmailFromApiKey } from "./user.ts";

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
   * The Alchemy profile to use for Cloudflare credentials. Defaults to:
   * - `process.env.CLOUDFLARE_PROFILE`
   * - `process.env.ALCHEMY_PROFILE`
   * - `"default"`
   *
   * If an API key or token is provided in these options or in the environment,
   * the profile will be ignored.
   */
  profile?: string;

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

/**
 * Creates a CloudflareApi instance with automatic account ID discovery if not provided
 *
 * @param options API options
 * @returns Promise resolving to a CloudflareApi instance
 */
export const createCloudflareApi = async (
  options: CloudflareApiOptions = {},
) => {
  const scopeOptions = await import("../scope.js").then(
    ({ Scope }) => Scope.getScope()?.providerCredentials.cloudflare,
  );
  return await createCloudflareApiInternal({
    baseUrl:
      options.baseUrl ??
      scopeOptions?.baseUrl ??
      process.env.CLOUDFLARE_BASE_URL,
    profile:
      options.profile ??
      scopeOptions?.profile ??
      process.env.CLOUDFLARE_PROFILE ??
      process.env.ALCHEMY_PROFILE,
    apiKey:
      (options.apiKey ?? scopeOptions?.apiKey)?.unencrypted ??
      process.env.CLOUDFLARE_API_KEY,
    apiToken:
      (options.apiToken ?? scopeOptions?.apiToken)?.unencrypted ??
      process.env.CLOUDFLARE_API_TOKEN,
    accountId:
      options.accountId ??
      scopeOptions?.accountId ??
      process.env.CLOUDFLARE_ACCOUNT_ID ??
      process.env.CF_ACCOUNT_ID,
    email: options.email ?? scopeOptions?.email ?? process.env.CLOUDFLARE_EMAIL,
  });
};

const createCloudflareApiInternal = memoize(
  async (options: {
    baseUrl?: string;
    profile?: string;
    apiToken?: string;
    apiKey?: string;
    accountId?: string;
    email?: string;
  }) => {
    if (options.profile) {
      const { provider, credentials } =
        await Provider.getWithCredentials<CloudflareAuth.Metadata>({
          provider: "cloudflare",
          profile: options.profile,
        });
      return new CloudflareApi({
        baseUrl: options.baseUrl,
        profile: options.profile,
        credentials,
        accountId: provider.metadata.id,
      });
    }

    const accountId = async (credentials: Credentials) =>
      options.accountId ??
      (await getCloudflareAccountId(CloudflareAuth.formatHeaders(credentials)));

    if (options.apiToken) {
      const credentials: Credentials.ApiToken = {
        type: "api-token",
        apiToken: options.apiToken,
      };
      return new CloudflareApi({
        baseUrl: options.baseUrl,
        credentials,
        accountId: await accountId(credentials),
      });
    }

    if (options.apiKey) {
      const email =
        options.email ?? (await getUserEmailFromApiKey(options.apiKey));
      const credentials: Credentials.ApiKey = {
        type: "api-key",
        apiKey: options.apiKey,
        email,
      };
      return new CloudflareApi({
        baseUrl: options.baseUrl,
        credentials,
        accountId: await accountId(credentials),
      });
    }

    try {
      const { provider, credentials } =
        await Provider.getWithCredentials<CloudflareAuth.Metadata>({
          provider: "cloudflare",
          profile: "default",
        });
      return new CloudflareApi({
        baseUrl: options.baseUrl,
        profile: "default",
        credentials,
        accountId: provider.metadata.id,
      });
    } catch (error) {
      throw new Error(
        [
          "No credentials found. Please run `alchemy login`, or set either CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY in your environment.",
          "Learn more: https://alchemy.run/guides/cloudflare/",
        ].join("\n"),
        { cause: error },
      );
    }
  },
);

/**
 * Cloudflare API client using raw fetch
 */
export class CloudflareApi {
  public readonly baseUrl: string;
  public readonly accountId: string;
  public readonly credentials: Credentials;
  public readonly profile: string | undefined;

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
    credentials: Credentials;
    profile?: string;
  }) {
    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4";
    this.accountId = options.accountId;
    this.credentials = options.credentials;
    this.profile = options.profile;
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
      ...(await CloudflareAuth.formatHeadersWithRefresh({
        profile: this.profile,
        credentials: this.credentials,
      })),
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
    init: RequestInit = {},
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
    init: RequestInit = {},
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
