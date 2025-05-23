import type { ProgressEvent } from "./client.js";

/**
 * Error thrown by Cloud Control API operations
 */
export class CloudControlError extends Error {
  constructor(
    public readonly message: string,
    public readonly response?: Response,
  ) {
    super(message);
  }
}
export class NetworkError extends CloudControlError {}
export class RequestError extends CloudControlError {
  constructor(
    response: Response,
    public readonly data: any,
  ) {
    super(response.statusText, response);
  }
}
export class UpdateFailedError extends CloudControlError {
  constructor(public readonly progressEvent: ProgressEvent) {
    super(progressEvent.StatusMessage!);
  }
}
export class AlreadyExistsError extends CloudControlError {
  constructor(public readonly progressEvent: ProgressEvent) {
    super(progressEvent.StatusMessage!);
  }
}
export class NotFoundError extends CloudControlError {
  constructor(public readonly progressEvent: ProgressEvent) {
    super(progressEvent.StatusMessage!);
  }
}
export class ResourceNotFoundException extends CloudControlError {
  constructor(public readonly response: Response) {
    super(response.statusText);
  }
}
export class TimeoutError extends CloudControlError {}

/**
 * Rate limit exceeded error - should be retried with exponential backoff
 */
export class ThrottlingException extends CloudControlError {
  constructor(
    public readonly response: Response,
    public readonly data: any,
  ) {
    super(data.message || "Rate exceeded", response);
  }
}

/**
 * Model validation failed error - indicates invalid resource properties
 */
export class ValidationException extends CloudControlError {
  constructor(
    public readonly response: Response,
    public readonly data: any,
  ) {
    super(data.message || "Model validation failed", response);
  }
}

/**
 * A previous Cloud Control API request is still running for the same
 * resource. These are transient and should be retried after a short delay.
 */
export class ConcurrentOperationError extends CloudControlError {
  /**
   * The request token of the in-flight operation from the AWS error message.
   * (e.g. "Concurrent operation found … with RequestToken 1234…")
   */
  constructor(
    public readonly message: string,
    public readonly requestToken: string,
  ) {
    super(message);
  }
}
