import { AwsClient } from "aws4fetch";

/**
 * Options for Cloud Control API requests
 */
export interface CloudControlOptions {
  /**
   * AWS region to use (defaults to us-east-1)
   */
  region?: string;

  /**
   * AWS access key ID (overrides environment variable)
   */
  accessKeyId?: string;

  /**
   * AWS secret access key (overrides environment variable)
   */
  secretAccessKey?: string;

  /**
   * AWS session token for temporary credentials
   */
  sessionToken?: string;
}

/**
 * Status of a Cloud Control API operation
 */
export type OperationStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "SUCCESS"
  | "FAILED"
  | "CANCEL_IN_PROGRESS"
  | "CANCEL_COMPLETE";

/**
 * Progress event from a Cloud Control API operation
 */
export interface ProgressEvent {
  /**
   * Type of event (e.g., "Resource Create", "Resource Update", etc.)
   */
  eventType?: string;

  /**
   * Identifier for the operation
   */
  identifier?: string;

  /**
   * Current status of the operation
   */
  status: OperationStatus;

  /**
   * Additional status message
   */
  statusMessage?: string;

  /**
   * Resource model after the operation
   */
  resourceModel?: Record<string, any>;

  /**
   * Error code if operation failed
   */
  errorCode?: string;

  /**
   * Error message if operation failed
   */
  errorMessage?: string;

  /**
   * Time the operation was requested
   */
  requestToken?: string;

  /**
   * Resource properties that caused errors
   */
  resourceProperties?: Record<string, any>;

  /**
   * Operation metrics
   */
  metrics?: Record<string, any>;
}

/**
 * Resource description returned by GetResource
 */
export interface ResourceDescription {
  /**
   * Resource identifier
   */
  Identifier: string;

  /**
   * Resource properties
   */
  Properties: Record<string, any>;

  /**
   * Resource type name
   */
  TypeName: string;
}

/**
 * Make a signed request to the Cloud Control API
 */
export async function request(
  client: AwsClient,
  region: string,
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const baseUrl = `https://cloudcontrol.${region}.api.aws`;
  const url = new URL(path, baseUrl);
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  if (body) {
    init.body = JSON.stringify(body);
  }

  const signedRequest = await client.sign(url.toString(), init);
  const response = await fetch(signedRequest);

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({
      message: response.statusText,
    }))) as { message?: string; code?: string };

    const error = new Error(
      errorData.message || `Cloud Control API error: ${response.statusText}`
    );
    error.name = "CloudControlError";
    throw error;
  }

  return response.json();
}

/**
 * Poll for operation completion
 */
export async function pollOperation(
  client: AwsClient,
  region: string,
  operationType: string,
  requestToken: string,
  maxAttempts = 60,
  initialDelay = 5000,
  maxDelay = 30000
): Promise<ProgressEvent> {
  let attempts = 0;
  let delay = initialDelay;

  while (attempts < maxAttempts) {
    const response = await request(client, region, "GET", "/progress", {
      OperationType: operationType,
      RequestToken: requestToken,
    });

    const event = response.ProgressEvent;

    if (event.status === "SUCCESS") {
      return event;
    }

    if (event.status === "FAILED" || event.status === "CANCEL_COMPLETE") {
      throw new Error(
        event.errorMessage || event.statusMessage || "Operation failed"
      );
    }

    // Exponential backoff with max delay
    delay = Math.min(delay * 1.5, maxDelay);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempts++;
  }

  throw new Error("Operation timed out");
}

/**
 * Get an AWS4Fetch client for Cloud Control API
 */
export function getClient(options: CloudControlOptions = {}): {
  client: AwsClient;
  region: string;
} {
  const region = options.region || process.env.AWS_REGION || "us-east-1";
  const accessKeyId = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables."
    );
  }

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    sessionToken: options.sessionToken || process.env.AWS_SESSION_TOKEN,
    service: "cloudcontrol",
    region,
  });

  return { client, region };
}

/**
 * Create a new resource
 */
export async function createResource(
  options: CloudControlOptions,
  typeName: string,
  desiredState: Record<string, any>
): Promise<Record<string, any>> {
  const { client, region } = getClient(options);

  const response = await request(client, region, "POST", "/resources", {
    TypeName: typeName,
    DesiredState: desiredState,
  });

  const event = await pollOperation(
    client,
    region,
    "CREATE_RESOURCE",
    response.ProgressEvent.RequestToken
  );

  return event.resourceModel || {};
}

/**
 * Get an existing resource
 */
export async function getResource(
  options: CloudControlOptions,
  typeName: string,
  identifier: string
): Promise<Record<string, any>> {
  const { client, region } = getClient(options);

  const response = await request(
    client,
    region,
    "GET",
    `/resources/${typeName}/${identifier}`
  );

  return response.ResourceDescription.Properties;
}

/**
 * Update an existing resource
 */
export async function updateResource(
  options: CloudControlOptions,
  typeName: string,
  identifier: string,
  patchDocument: Record<string, any>
): Promise<Record<string, any>> {
  const { client, region } = getClient(options);

  const response = await request(
    client,
    region,
    "PATCH",
    `/resources/${typeName}/${identifier}`,
    {
      PatchDocument: patchDocument,
    }
  );

  const event = await pollOperation(
    client,
    region,
    "UPDATE_RESOURCE",
    response.ProgressEvent.RequestToken
  );

  return event.resourceModel || {};
}

/**
 * Delete a resource
 */
export async function deleteResource(
  options: CloudControlOptions,
  typeName: string,
  identifier: string
): Promise<void> {
  const { client, region } = getClient(options);

  const response = await request(
    client,
    region,
    "DELETE",
    `/resources/${typeName}/${identifier}`
  );

  await pollOperation(
    client,
    region,
    "DELETE_RESOURCE",
    response.ProgressEvent.RequestToken
  );
}
