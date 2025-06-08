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
/**
 * Helper function to detect and handle OAuth token authentication limitations
 * Provides specific guidance when OAuth tokens don't support required operations
 *
 * @param response The fetch Response object
 * @param action The action being performed (e.g., "creating", "deleting")
 * @param resourceType The type of resource being acted upon (e.g., "email routing")
 * @returns Promise<never> if it's an OAuth error, undefined otherwise
 */
export async function handleOAuthError(
  response: Response,
  action: string,
  resourceType: string,
): Promise<never | undefined> {
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { errors: [{ message: text }] };
  }
  
  const errors: { message: string; code?: number }[] = json?.errors || [];
  const isOAuthError = errors.some(error => 
    error.message?.includes("oauth_token authentication scheme") ||
    error.message?.includes("POST method not allowed") ||
    error.code === 10000
  );
  
  if (isOAuthError) {
    throw new Error(
      `${resourceType} ${action} requires API token authentication. ` +
      `OAuth tokens from 'wrangler login' don't support this operation. ` +
      `Please set CLOUDFLARE_API_TOKEN environment variable or pass apiToken option. ` +
      `You can create an API token at https://dash.cloudflare.com/profile/api-tokens`
    );
  }
  
  return undefined;
}

export async function handleApiError(
  response: Response,
  action: string,
  resourceType: string,
  resourceName?: string,
): Promise<never> {
  // First check for OAuth-specific errors
  await handleOAuthError(response, action, resourceType);
  
  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { errors: [{ message: text }] };
  }
  const errors: { message: string }[] = json?.errors || [
    { message: response.statusText },
  ];
  const errorMessage = `Error ${response.status} ${action} ${resourceType}${resourceName ? ` '${resourceName}'` : ""}: ${errors[0]?.message || response.statusText}`;
  throw new CloudflareApiError(errorMessage, response, errors);
}
