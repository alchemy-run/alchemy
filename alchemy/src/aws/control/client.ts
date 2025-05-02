import { AwsClient } from "aws4fetch";

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
   * Operation identifier
   */
  operationId?: string;

  /**
   * Current status of the operation
   */
  status: OperationStatus;

  /**
   * Resource model (properties) if available
   */
  resourceModel?: Record<string, any>;

  /**
   * Resource identifier if available
   */
  identifier?: string;

  /**
   * Error details if operation failed
   */
  errorCode?: string;
  message?: string;
  retryAfterSeconds?: number;
}

/**
 * Error thrown by Cloud Control API operations
 */
export class CloudControlError extends Error {
  name = "CloudControlError";
  code?: string;
  requestId?: string;
  statusCode?: number;
  operation?: string;
  resourceType?: string;
  resourceIdentifier?: string;
}

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

  /**
   * Maximum number of attempts for polling operations
   */
  maxPollingAttempts?: number;

  /**
   * Initial delay in milliseconds between polling attempts
   */
  initialPollingDelay?: number;

  /**
   * Maximum delay in milliseconds between polling attempts
   */
  maxPollingDelay?: number;
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
 * Make a request to the Cloud Control API
 */
async function request(
  client: AwsClient,
  region: string,
  method: string,
  action: string,
  body?: any
): Promise<any> {
  const url = new URL(`https://cloudcontrol.${region}.amazonaws.com/v1/`);

  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Amz-Target": `CloudControl_20210730.${action}`,
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

    const error = new CloudControlError(
      errorData.message || "Unknown Cloud Control API error"
    );
    error.code = errorData.code;
    error.requestId = response.headers.get("x-amzn-requestid") || undefined;
    error.statusCode = response.status;
    error.operation = action;
    throw error;
  }

  return response.json();
}

/**
 * Poll for operation completion
 */
async function pollOperation(
  client: AwsClient,
  region: string,
  operationId: string,
  options: Required<
    Pick<
      CloudControlOptions,
      "maxPollingAttempts" | "initialPollingDelay" | "maxPollingDelay"
    >
  >
): Promise<ProgressEvent> {
  let attempts = 0;
  let delay = options.initialPollingDelay;

  while (attempts < options.maxPollingAttempts) {
    const response = await request(
      client,
      region,
      "POST",
      "GetResourceRequestStatus",
      {
        RequestToken: operationId,
      }
    );

    const event = response.ProgressEvent;
    if (event.status === "SUCCESS" || event.status === "FAILED") {
      return event;
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, options.maxPollingDelay);
    attempts++;
  }

  throw new CloudControlError(
    `Operation ${operationId} timed out after ${attempts} attempts`
  );
}

/**
 * Create a Cloud Control API client
 */
export function createCloudControlClient(options: CloudControlOptions = {}) {
  const region = options.region || "us-east-1";
  const maxPollingAttempts = options.maxPollingAttempts || 30;
  const initialPollingDelay = options.initialPollingDelay || 1000;
  const maxPollingDelay = options.maxPollingDelay || 10000;

  const client = new AwsClient({
    accessKeyId: options.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey:
      options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "",
    sessionToken: options.sessionToken || process.env.AWS_SESSION_TOKEN,
  });

  return {
    /**
     * Create a new resource
     */
    async createResource(
      typeName: string,
      desiredState: Record<string, any>
    ): Promise<ProgressEvent> {
      const response = await request(client, region, "POST", "CreateResource", {
        TypeName: typeName,
        DesiredState: desiredState,
      });

      return pollOperation(client, region, response.ProgressEvent.operationId, {
        maxPollingAttempts,
        initialPollingDelay,
        maxPollingDelay,
      });
    },

    /**
     * Get a resource's current state
     */
    async getResource(
      typeName: string,
      identifier: string
    ): Promise<Record<string, any>> {
      const response = await request(client, region, "POST", "GetResource", {
        TypeName: typeName,
        Identifier: identifier,
      });

      return response.ResourceDescription.Properties;
    },

    /**
     * Update a resource
     */
    async updateResource(
      typeName: string,
      identifier: string,
      patchDocument: Record<string, any>
    ): Promise<ProgressEvent> {
      const response = await request(client, region, "POST", "UpdateResource", {
        TypeName: typeName,
        Identifier: identifier,
        PatchDocument: JSON.stringify(patchDocument),
      });

      return pollOperation(client, region, response.ProgressEvent.operationId, {
        maxPollingAttempts,
        initialPollingDelay,
        maxPollingDelay,
      });
    },

    /**
     * Delete a resource
     */
    async deleteResource(
      typeName: string,
      identifier: string
    ): Promise<ProgressEvent> {
      const response = await request(client, region, "POST", "DeleteResource", {
        TypeName: typeName,
        Identifier: identifier,
      });

      return pollOperation(client, region, response.ProgressEvent.operationId, {
        maxPollingAttempts,
        initialPollingDelay,
        maxPollingDelay,
      });
    },

    /**
     * List resources of a given type
     */
    async listResources(
      typeName: string,
      nextToken?: string
    ): Promise<{
      resources: Array<{ identifier: string; properties: Record<string, any> }>;
      nextToken?: string;
    }> {
      const response = await request(client, region, "POST", "ListResources", {
        TypeName: typeName,
        NextToken: nextToken,
      });

      return {
        resources: response.ResourceDescriptions.map((desc: any) => ({
          identifier: desc.Identifier,
          properties: desc.Properties,
        })),
        nextToken: response.NextToken,
      };
    },
  };
}
