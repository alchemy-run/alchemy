/**
 * Authentication options for Cloudflare API
 */
export interface CloudflareAuthOptions {
  /**
   * If true, throw an error when no authentication is found
   * @default true
   */
  required?: boolean;

  /**
   * Email to use with API Key
   * If not provided, will attempt to discover from Cloudflare API
   */
  email?: string;
}

/**
 * Authentication headers for Cloudflare API
 */
export interface CloudflareAuthHeaders {
  /**
   * Authentication headers to use with fetch
   */
  headers: Record<string, string>;

  /**
   * Type of authentication being used
   */
  type: "token" | "key" | "none";

  /**
   * User email (only present when using API Key auth)
   */
  email?: string;
}

/**
 * Response from the Cloudflare User API
 */
interface CloudflareUserResponse {
  success: boolean;
  result: {
    id: string;
    email: string;
    name: string;
    [key: string]: any;
  };
}

/**
 * Get authentication headers for Cloudflare API
 *
 * Priority:
 * 1. API Token (CLOUDFLARE_API_TOKEN) - Recommended by Cloudflare
 * 2. API Key (CLOUDFLARE_API_KEY) - Will attempt to discover email automatically
 *
 * @param options Authentication options
 * @returns Authentication headers
 */
export async function getCloudflareAuth(
  options: CloudflareAuthOptions = {},
): Promise<CloudflareAuthHeaders> {
  const { required = true } = options;

  // Check for API Token (preferred method)
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken) {
    return {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      type: "token",
    };
  }

  // Check for API Key
  const apiKey = process.env.CLOUDFLARE_API_KEY;
  if (apiKey) {
    // If email is provided directly, use it
    const providedEmail = options.email || process.env.CLOUDFLARE_EMAIL;
    if (providedEmail) {
      return {
        headers: {
          "X-Auth-Key": apiKey,
          "X-Auth-Email": providedEmail,
        },
        type: "key",
        email: providedEmail,
      };
    }

    // Otherwise, try to discover email from Cloudflare API
    try {
      const email = await getUserEmailFromApiKey(apiKey);
      return {
        headers: {
          "X-Auth-Key": apiKey,
          "X-Auth-Email": email,
        },
        type: "key",
        email,
      };
    } catch (error) {
      console.error("Failed to discover email from API key:", error);
      throw new Error(
        "Failed to automatically discover email for API Key authentication.\n" +
          "Options:\n" +
          "1. Set CLOUDFLARE_EMAIL environment variable\n" +
          "2. Use CLOUDFLARE_API_TOKEN instead (recommended by Cloudflare)",
      );
    }
  }

  // No authentication found
  if (required) {
    throw new Error(
      "Cloudflare authentication required. Set either:\n" +
        "1. CLOUDFLARE_API_TOKEN (recommended by Cloudflare)\n" +
        "   Generate a token at: https://dash.cloudflare.com/profile/api-tokens\n" +
        "2. CLOUDFLARE_API_KEY environment variable",
    );
  }

  return {
    headers: {},
    type: "none",
  };
}

/**
 * Fetch the user's email from Cloudflare API using API Key
 *
 * @param apiKey The Cloudflare API key
 * @returns The user's email
 */
async function getUserEmailFromApiKey(apiKey: string): Promise<string> {
  try {
    const baseUrl = "https://api.cloudflare.com/client/v4";

    // Call the /user endpoint to get user information
    const response = await fetch(`${baseUrl}/user`, {
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Key": apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to get user information: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as CloudflareUserResponse;

    if (!data.success || !data.result || !data.result.email) {
      throw new Error("Cloudflare API did not return valid user information");
    }

    return data.result.email;
  } catch (error) {
    console.error("Error retrieving email from Cloudflare API:", error);
    throw new Error(
      "Failed to automatically discover email for API Key authentication",
    );
  }
}

/**
 * Get headers for a Cloudflare API request, including content-type
 *
 * @param contentType Content type for the request
 * @param options Authentication options
 * @returns Complete headers for the request
 */
export async function getCloudflareHeaders(
  contentType = "application/json",
  options: CloudflareAuthOptions = {},
): Promise<Record<string, string>> {
  const auth = await getCloudflareAuth(options);

  return {
    "Content-Type": contentType,
    ...auth.headers,
  };
}
