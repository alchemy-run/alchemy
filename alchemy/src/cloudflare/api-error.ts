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
  const errors: { message: string }[] = json.errors || [
    { message: response.statusText },
  ];
  const errorMessage = `Error ${action} ${resourceType} '${resourceName}': ${errors[0]?.message || response.statusText}`;

  throw new CloudflareApiError(errorMessage, response, errors);
}
