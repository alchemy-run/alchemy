import type { Secret } from "../secret";
import { type CloudflareAuthOptions, getCloudflareHeaders } from "./auth";

/**
 * Options for Cloudflare API requests
 */
export interface CloudflareApiOptions {
  /**
   * API Key to use (overrides CLOUDFLARE_API_KEY env var)
   */
  apiKey?: Secret;

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
 * Account information returned from Cloudflare API
 */
interface CloudflareAccount {
  id: string;
  name: string;
}

/**
 * Custom error class for Cloudflare API errors
 * Includes HTTP status information from the Response
 */
export class CloudflareApiError extends Error {
  /**
   * HTTP status code
   */
  status: number;

  /**
   * HTTP status text
   */
  statusText: string;

  /**
   * Raw error data from the API
   */
  errorData?: any;

  /**
   * Create a new CloudflareApiError
   */
  constructor(message: string, response: Response, errorData?: any) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.errorData = errorData;

    // Ensure instanceof works correctly
    Object.setPrototypeOf(this, CloudflareApiError.prototype);
  }
}

/**
 * Helper function to handle API errors
 *
 * @param response The fetch Response object
 * @param action The action being performed (e.g., "creating", "deleting")
 * @param resourceType The type of resource being acted upon (e.g., "R2 bucket", "Worker")
 * @param resourceName The name/identifier of the specific resource
 * @returns Never returns - always throws an error
 */
export async function handleApiError(
  response: Response,
  action: string,
  resourceType: string,
  resourceName: string
): Promise<never> {
  const json: any = await response.json();
  console.log(json);
  const errorData: any = json.errors || [{ message: response.statusText }];

  const errorMessage = `Error ${action} ${resourceType} '${resourceName}': ${errorData.errors?.[0]?.message || response.statusText}`;

  throw new CloudflareApiError(errorMessage, response, errorData);
}

/**
 * Creates a CloudflareApi instance with automatic account ID discovery if not provided
 *
 * @param options API options
 * @returns Promise resolving to a CloudflareApi instance
 */
export async function createCloudflareApi(
  options: CloudflareApiOptions = {}
): Promise<CloudflareApi> {
  try {
    return new CloudflareApi({
      ...options,
      accountId: await CloudflareAccountId(options),
    });
  } catch (error) {
    console.error("Error during Cloudflare account ID discovery:", error);
    throw new Error(
      "Failed to automatically discover Cloudflare account ID. Please provide an account ID explicitly or ensure your API token/key has sufficient permissions."
    );
  }
}

export type CloudflareAccountId = string & {
  readonly __brand: "CloudflareAccountId";
};

export async function CloudflareAccountId(
  options: CloudflareApiOptions = {}
): Promise<CloudflareAccountId> {
  return (options.accountId ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    (await fetchAccountId())) as CloudflareAccountId;
}

/**
 * Cloudflare API client using raw fetch
 */
export class CloudflareApi {
  /** Base URL for Cloudflare API */
  readonly baseUrl: string;

  /** Cloudflare API Key */
  readonly apiKey: string;

  /** Cloudflare account ID */
  readonly accountId: string;

  /** Cloudflare zone ID (if provided) */
  readonly zoneId: string | null;

  /** User email (when using API Key auth) */
  readonly email?: string;

  /** Auth options for making requests */
  private readonly authOptions: CloudflareAuthOptions;

  /**
   * Create a new Cloudflare API client
   * Use createCloudflareApi factory function instead of direct constructor
   * for automatic account ID discovery.
   *
   * @param options API options
   */
  constructor(options: CloudflareApiOptions = {}) {
    this.baseUrl = "https://api.cloudflare.com/client/v4";

    const apiKey =
      options.apiKey?.unencrypted ||
      process.env.CLOUDFLARE_API_KEY ||
      undefined;
    if (!apiKey) {
      throw new Error(
        "No API key provided. Use createCloudflareApi() instead for automatic account discovery."
      );
    }
    this.apiKey = apiKey;

    this.email = options.email || process.env.CLOUDFLARE_EMAIL;
    if (!this.email) {
      throw new Error(
        "No email provided. Use createCloudflareApi() instead for automatic account discovery."
      );
    }

    // Get account ID from options or environment
    this.accountId =
      options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
    if (!this.accountId) {
      throw new Error(
        "No account ID provided. Use createCloudflareApi() instead for automatic account discovery."
      );
    }

    // Zone ID is optional for some operations
    this.zoneId = options.zoneId || process.env.CLOUDFLARE_ZONE_ID || null;

    // Store auth options for later use
    this.authOptions = {
      email: this.email,
    };
  }

  /**
   * Make a fetch request to the Cloudflare API
   *
   * @param path API path (without base URL)
   * @param init Fetch init options
   * @returns Raw Response object from fetch
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    // Get content type from init headers or default to application/json
    let contentType = "application/json";
    if (init.headers) {
      const initHeaders = init.headers as Record<string, string>;
      if (initHeaders["Content-Type"]) {
        contentType = initHeaders["Content-Type"];
      }
    }

    // Get auth headers (async now)
    const authHeaders = await getCloudflareHeaders(
      contentType,
      this.authOptions
    );

    // Combine all headers
    const combinedHeaders: Record<string, string> = {
      ...authHeaders,
    };

    // Add headers from init if provided
    if (init.headers) {
      const initHeadersObj = init.headers as Record<string, string>;
      Object.keys(initHeadersObj).forEach((key) => {
        combinedHeaders[key] = initHeadersObj[key];
      });
    }

    // If using FormData, remove Content-Type to let browser set it with boundary
    if (init.body instanceof FormData) {
      delete combinedHeaders["Content-Type"];
    }

    const url = `${this.baseUrl}${path}`;

    // Make the request
    return fetch(url, {
      ...init,
      headers: combinedHeaders,
    });
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

/**
 * Create a temporary API client for bootstrapping
 * This client can only be used to fetch the account ID
 */
async function fetchAccountId(): Promise<string> {
  // Create a minimal API client for bootstrapping
  const baseUrl = "https://api.cloudflare.com/client/v4";

  // Get content type and auth headers
  const authHeaders = await getCloudflareHeaders("application/json");

  // Make the request to get accounts
  const response = await fetch(`${baseUrl}/accounts`, {
    method: "GET",
    headers: authHeaders,
  });

  if (!response.ok) {
    const errorData: any = await response.json().catch(() => ({
      errors: [{ message: response.statusText }],
    }));

    throw new Error(
      `Error fetching Cloudflare accounts: ${errorData.errors?.[0]?.message || response.statusText}`
    );
  }

  const data: any = await response.json();
  const accounts = data.result as CloudflareAccount[];

  if (!accounts || accounts.length === 0) {
    throw new Error(
      "No Cloudflare accounts found. Check your API token/key permissions."
    );
  }

  // Return the first account ID
  return accounts[0].id;
}
