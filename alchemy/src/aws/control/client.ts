import { AwsClient } from "aws4fetch";

/**
 * Options for Cloud Control API client
 */
export interface CloudControlClientOptions {
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
 * Client for AWS Cloud Control API
 */
export class CloudControlClient {
  private readonly client: AwsClient;
  private readonly baseUrl: string;
  private readonly maxPollingAttempts: number;
  private readonly initialPollingDelay: number;
  private readonly maxPollingDelay: number;

  /**
   * Create a new Cloud Control API client
   */
  constructor(options: CloudControlClientOptions = {}) {
    const region = options.region || process.env.AWS_REGION || "us-east-1";
    const accessKeyId = options.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey =
      options.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "AWS credentials not found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables."
      );
    }

    this.client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      sessionToken: options.sessionToken || process.env.AWS_SESSION_TOKEN,
      service: "cloudcontrol",
      region,
    });

    this.baseUrl = `https://cloudcontrol.${region}.amazonaws.com/`;
    this.maxPollingAttempts = options.maxPollingAttempts || 60; // 5 minutes with 5s initial delay
    this.initialPollingDelay = options.initialPollingDelay || 5000; // 5 seconds
    this.maxPollingDelay = options.maxPollingDelay || 30000; // 30 seconds
  }

  /**
   * Make a signed request to the Cloud Control API
   */
  private async request(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    const url = new URL(path, this.baseUrl);
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

    const signedRequest = await this.client.sign(url.toString(), init);
    const response = await fetch(signedRequest);

    if (!response.ok) {
      const errorData = (await response
        .json()
        .catch(() => ({ message: response.statusText }))) as {
        message: string;
      };
      throw new Error(`Cloud Control API error: ${errorData.message}`);
    }

    return response.json();
  }

  /**
   * Poll for operation completion
   */
  private async pollOperation(
    operationType: string,
    requestToken: string
  ): Promise<ProgressEvent> {
    let attempts = 0;
    let delay = this.initialPollingDelay;

    while (attempts < this.maxPollingAttempts) {
      const response = await this.request("GET", "/progress", {
        OperationType: operationType,
        RequestToken: requestToken,
      });

      const event = response.ProgressEvent;

      if (event.status === "SUCCESS") {
        return event;
      }

      if (event.status === "FAILED" || event.status === "CANCEL_COMPLETE") {
        throw new Error(
          `Operation failed: ${event.errorMessage || event.statusMessage}`
        );
      }

      // Exponential backoff with max delay
      delay = Math.min(delay * 1.5, this.maxPollingDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempts++;
    }

    throw new Error("Operation timed out");
  }

  /**
   * Create a new resource
   */
  async createResource(
    typeName: string,
    desiredState: Record<string, any>
  ): Promise<Record<string, any>> {
    const response = await this.request("POST", "/resources", {
      TypeName: typeName,
      DesiredState: desiredState,
    });

    const event = await this.pollOperation(
      "CREATE_RESOURCE",
      response.ProgressEvent.RequestToken
    );

    return event.resourceModel || {};
  }

  /**
   * Get an existing resource
   */
  async getResource(
    typeName: string,
    identifier: string
  ): Promise<Record<string, any>> {
    const response = await this.request(
      "GET",
      `/resources/${typeName}/${identifier}`
    );
    return response.ResourceDescription.Properties;
  }

  /**
   * Update an existing resource
   */
  async updateResource(
    typeName: string,
    identifier: string,
    patchDocument: Record<string, any>
  ): Promise<Record<string, any>> {
    const response = await this.request(
      "PATCH",
      `/resources/${typeName}/${identifier}`,
      {
        PatchDocument: patchDocument,
      }
    );

    const event = await this.pollOperation(
      "UPDATE_RESOURCE",
      response.ProgressEvent.RequestToken
    );

    return event.resourceModel || {};
  }

  /**
   * Delete a resource
   */
  async deleteResource(typeName: string, identifier: string): Promise<void> {
    const response = await this.request(
      "DELETE",
      `/resources/${typeName}/${identifier}`
    );

    await this.pollOperation(
      "DELETE_RESOURCE",
      response.ProgressEvent.RequestToken
    );
  }
}

/**
 * Create a new Cloud Control API client
 */
export function createCloudControlClient(
  options: CloudControlClientOptions = {}
): CloudControlClient {
  return new CloudControlClient(options);
}
