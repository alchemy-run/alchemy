import { AwsClient } from "aws4fetch";

import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import {
  AlreadyExistsError,
  CloudControlError,
  NetworkError,
  RequestError,
  TimeoutError,
} from "./error";

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
   * Error code if the operation failed
   */
  ErrorCode?: string;

  /**
   * Time when the event occurred
   */
  EventTime?: number;

  /**
   * Token for hooks associated with the request
   */
  HooksRequestToken?: string;

  /**
   * Resource identifier
   */
  Identifier: string;

  /**
   * Operation being performed (CREATE, READ, UPDATE, DELETE)
   */
  Operation?: string;

  /**
   * Current status of the operation
   */
  OperationStatus: OperationStatus;

  /**
   * Token that identifies the request
   */
  RequestToken: string;

  /**
   * JSON string representation of the resource model
   */
  ResourceModel?: string;

  /**
   * Number of seconds to wait before retrying
   */
  RetryAfter?: number;

  /**
   * Status message providing details about the operation
   */
  StatusMessage: string;

  /**
   * Type name of the resource
   */
  TypeName?: string;
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

  /**
   * Overall timeout in milliseconds for operations
   */
  operationTimeout?: number;

  /**
   * Maximum number of retries for retryable errors
   */
  maxRetries?: number;
}

// List of retryable error codes
const RETRYABLE_ERRORS = new Set([
  "ThrottlingException",
  "ServiceUnavailable",
  "InternalFailure",
  "TooManyRequestsException",
  "RequestLimitExceeded",
  "Throttling",
  "ThrottlingException",
  "LimitExceededException",
]);

/**
 * Make a request to the Cloud Control API with retry logic
 */
async function request(
  client: AwsClient,
  region: string,
  method: string,
  action: string,
  params?: any,
  maxRetries = 0,
): Promise<any> {
  let attempt = 0;

  while (true) {
    try {
      const args = [
        `https://cloudcontrolapi.${region}.amazonaws.com/?Action=${action}&Version=2021-09-30`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-amz-json-1.0",
            "x-amz-target": `CloudApiService.${action}`,
          },
          body: JSON.stringify(params),
        },
      ] as const;
      console.log(params);
      const signedRequest = await client.sign(...args);
      console.log(...args);
      const response = await fetch(signedRequest);
      console.log(response.status);

      if (response.ok) {
        const result = await response.json();
        console.log(result);
        return result;
      }

      const responseBody = await response.json();
      console.log(responseBody);
      throw new RequestError(response);
    } catch (error: any) {
      console.log(error);
      if (error instanceof RequestError) {
        throw error;
      }

      // Handle network errors
      const networkError = new NetworkError(
        error.message || "Network error during Cloud Control API request",
      );

      if (attempt < maxRetries) {
        const retryDelay = Math.min(2 ** attempt * 100, 5000);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        attempt++;
        continue;
      }

      throw networkError;
    }
  }
}

/**
 * Poll for operation completion with improved timeout and error handling
 */
async function pollOperation(
  client: AwsClient,
  region: string,
  progressEvent: ProgressEvent,
  options: Required<
    Pick<
      CloudControlOptions,
      | "maxPollingAttempts"
      | "initialPollingDelay"
      | "maxPollingDelay"
      | "operationTimeout"
    >
  >,
): Promise<ProgressEvent> {
  let attempts = 0;
  let delay = options.initialPollingDelay;
  const startTime = Date.now();

  while (attempts < options.maxPollingAttempts) {
    if (Date.now() - startTime > options.operationTimeout) {
      throw new TimeoutError(
        `Operation ${progressEvent.Operation} timed out after ${
          options.operationTimeout / 1000
        } seconds`,
      );
    }

    try {
      const response = await request(
        client,
        region,
        "POST",
        "GetResourceRequestStatus",
        {
          RequestToken: progressEvent.RequestToken,
        },
      );

      const event = response.ProgressEvent as ProgressEvent;

      console.log("event", event);

      if (event.OperationStatus === "SUCCESS") {
        return event;
      }

      if (event.OperationStatus === "FAILED") {
        if (event.ErrorCode === "AlreadyExists") {
          throw new AlreadyExistsError(event);
        }
        throw new CloudControlError(
          `Operation ${progressEvent.Operation} failed: ${event.StatusMessage}`,
          response,
        );
      }

      // Use the suggested retry delay if provided
      const waitTime = event.RetryAfter ? event.RetryAfter * 1000 : delay;

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay = Math.min(delay * 2, options.maxPollingDelay);
      attempts++;
    } catch (error: any) {
      if (error instanceof CloudControlError) {
        throw error;
      }

      // For retryable errors, continue polling
      // console.warn(
      //   `Error polling operation ${operationId} (attempt ${attempts + 1}):`,
      //   error,
      // );

      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delay * 2, options.maxPollingDelay)),
      );
      delay = Math.min(delay * 2, options.maxPollingDelay);
      attempts++;
    }
  }

  throw new CloudControlError(
    `Operation ${progressEvent.Operation} polling exceeded maximum attempts (${options.maxPollingAttempts})`,
  );
}

/**
 * Create a Cloud Control API client
 */
export async function createCloudControlClient(
  options: CloudControlOptions = {},
) {
  const region = options.region || "us-east-1";
  const maxPollingAttempts = options.maxPollingAttempts || 30;
  const initialPollingDelay = options.initialPollingDelay || 1000;
  const maxPollingDelay = options.maxPollingDelay || 10000;
  const operationTimeout = options.operationTimeout || 300000; // 5 minutes default
  const maxRetries = options.maxRetries || 3;

  const credentials = await fromNodeProviderChain()();

  const client = new AwsClient({
    ...credentials,
    service: "cloudcontrolapi",
    region: region,
  });

  return {
    /**
     * Create a new resource
     */
    async createResource(
      typeName: string,
      desiredState: Record<string, any>,
    ): Promise<ProgressEvent> {
      const response = await request(
        client,
        region,
        "POST",
        "CreateResource",
        {
          TypeName: typeName,
          DesiredState: JSON.stringify(desiredState),
        },
        maxRetries,
      );

      return pollOperation(
        client,
        region,
        response.ProgressEvent as ProgressEvent,
        {
          maxPollingAttempts,
          initialPollingDelay,
          maxPollingDelay,
          operationTimeout,
        },
      );
    },

    /**
     * Get a resource's current state
     */
    async getResource(
      typeName: string,
      identifier: string,
    ): Promise<Record<string, any>> {
      const response = await request(
        client,
        region,
        "POST",
        "GetResource",
        {
          TypeName: typeName,
          Identifier: identifier,
        },
        maxRetries,
      );

      return response.ResourceDescription.Properties;
    },

    /**
     * Update a resource
     */
    async updateResource(
      typeName: string,
      identifier: string,
      patchDocument: Record<string, any>,
    ): Promise<ProgressEvent> {
      const response = await request(
        client,
        region,
        "POST",
        "UpdateResource",
        {
          TypeName: typeName,
          Identifier: identifier,
          PatchDocument: JSON.stringify(patchDocument),
        },
        maxRetries,
      );

      return pollOperation(client, region, response.ProgressEvent.operationId, {
        maxPollingAttempts,
        initialPollingDelay,
        maxPollingDelay,
        operationTimeout,
      });
    },

    /**
     * Delete a resource
     */
    async deleteResource(
      typeName: string,
      identifier: string,
    ): Promise<ProgressEvent> {
      const response = await request(
        client,
        region,
        "POST",
        "DeleteResource",
        {
          TypeName: typeName,
          Identifier: identifier,
        },
        maxRetries,
      );

      return pollOperation(client, region, response.ProgressEvent.operationId, {
        maxPollingAttempts,
        initialPollingDelay,
        maxPollingDelay,
        operationTimeout,
      });
    },

    /**
     * List resources of a given type
     */
    async listResources(
      typeName: string,
      nextToken?: string,
    ): Promise<{
      resources: Array<{ identifier: string; properties: Record<string, any> }>;
      nextToken?: string;
    }> {
      const response = await request(
        client,
        region,
        "POST",
        "ListResources",
        {
          TypeName: typeName,
          NextToken: nextToken,
        },
        maxRetries,
      );

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
