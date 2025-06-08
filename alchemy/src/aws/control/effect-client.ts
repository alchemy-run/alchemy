import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { loadConfig } from "@smithy/node-config-provider";
import { AwsClient } from "aws4fetch";
import { Effect, Data, Schedule, Duration, Layer, Context } from "effect";

// Re-export types from the original client for compatibility
export type { OperationStatus, ProgressEvent, CloudControlOptions } from "./client.ts";

/**
 * Effect-based error types for CloudControl API
 */
export class CloudControlError extends Data.TaggedError("CloudControlError")<{
  readonly message: string;
  readonly response?: Response;
}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RequestError extends Data.TaggedError("RequestError")<{
  readonly response: Response;
  readonly data: unknown;
}> {}

export class UpdateFailedError extends Data.TaggedError("UpdateFailedError")<{
  readonly progressEvent: ProgressEvent;
}> {}

export class AlreadyExistsError extends Data.TaggedError("AlreadyExistsError")<{
  readonly progressEvent: ProgressEvent;
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly progressEvent: ProgressEvent;
}> {}

export class ResourceNotFoundException extends Data.TaggedError("ResourceNotFoundException")<{
  readonly response: Response;
}> {}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
}> {}

export class ThrottlingException extends Data.TaggedError("ThrottlingException")<{
  readonly response: Response;
  readonly data: unknown;
}> {}

export class ValidationException extends Data.TaggedError("ValidationException")<{
  readonly response: Response;
  readonly data: unknown;
}> {}

export class ConcurrentOperationError extends Data.TaggedError("ConcurrentOperationError")<{
  readonly message: string;
  readonly requestToken: string;
}> {}

// Type alias for imports
import type { OperationStatus, ProgressEvent, CloudControlOptions } from "./client.ts";

/**
 * CloudControl client configuration context
 */
export class CloudControlConfig extends Context.Tag("CloudControlConfig")<
  CloudControlConfig,
  {
    readonly client: AwsClient;
    readonly region: string;
    readonly initialPollingDelay: number;
    readonly maxPollingDelay: number;
    readonly maxRetries: number;
  }
>() {}

/**
 * Effect-based fetch that wraps aws4fetch with proper error handling
 */
const effectFetch = <T>(
  action: string,
  params?: unknown,
): Effect.Effect<T, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ResourceNotFoundException | ConcurrentOperationError, CloudControlConfig> =>
  Effect.gen(function* () {
    const config = yield* CloudControlConfig;
    
    const args = [
      `https://cloudcontrolapi.${config.region}.amazonaws.com/?Action=${action}&Version=2021-09-30`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": `CloudApiService.${action}`,
        },
        body: JSON.stringify(params),
      },
    ] as const;

    const signedRequest = yield* Effect.tryPromise(() => config.client.sign(...args));
    
    const response = yield* Effect.tryPromise(() => fetch(signedRequest)).pipe(
      Effect.catchAll((error) =>
        Effect.fail(new NetworkError({
          message: `Network error during fetch: ${String(error)}`,
          cause: error,
        }))
      )
    );

    if (!response.ok) {
      const data = yield* Effect.tryPromise(() => response.json()).pipe(
        Effect.catchAll(() => Effect.succeed({}))
      );

      // Handle specific AWS CloudControl API errors
      if (data.__type === "com.amazon.cloudapiservice#ResourceNotFoundException") {
        return yield* Effect.fail(new ResourceNotFoundException({ response }));
      }
      
      if (data.__type === "com.amazon.cloudapiservice#ConcurrentOperationException") {
        const message = data.Message || "";
        const requestTokenMatch = message.match(/RequestToken\s+([a-fA-F0-9-]+)/);
        if (!requestTokenMatch) {
          return yield* Effect.fail(new RequestError({
            response,
            data: {
              ...data,
              message: `ConcurrentOperationException without request token: ${message}`,
            },
          }));
        }
        return yield* Effect.fail(new ConcurrentOperationError({
          message,
          requestToken: requestTokenMatch[1],
        }));
      }
      
      if (data.__type === "com.amazon.coral.availability#ThrottlingException") {
        return yield* Effect.fail(new ThrottlingException({ response, data }));
      }
      
      if (data.__type === "com.amazon.coral.validate#ValidationException") {
        return yield* Effect.fail(new ValidationException({ response, data }));
      }
      
      return yield* Effect.fail(new RequestError({ response, data }));
    }

    return yield* Effect.tryPromise(() => response.json() as Promise<T>);
  });

/**
 * Retry schedule for retryable errors (throttling and network issues)
 */
const retrySchedule = Schedule.exponential(Duration.millis(1000)).pipe(
  Schedule.intersect(Schedule.recurs(3)),
  Schedule.whileInput((error: CloudControlError) =>
    error._tag === "ThrottlingException" || 
    error._tag === "NetworkError"
  )
);

/**
 * Create a resource using Effect
 */
export const createResource = (
  typeName: string,
  desiredState: Record<string, unknown>,
): Effect.Effect<ProgressEvent, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ResourceNotFoundException | ConcurrentOperationError | UpdateFailedError | AlreadyExistsError | NotFoundError, CloudControlConfig> =>
  Effect.gen(function* () {
    const { ProgressEvent } = yield* effectFetch<{ ProgressEvent: ProgressEvent }>("CreateResource", {
      TypeName: typeName,
      DesiredState: JSON.stringify(desiredState),
    }).pipe(Effect.retry(retrySchedule));

    return yield* poll(ProgressEvent.RequestToken, "CreateResource");
  });

/**
 * Get a resource using Effect
 */
export const getResource = (
  typeName: string,
  identifier: string,
): Effect.Effect<Record<string, unknown> | undefined, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ConcurrentOperationError, CloudControlConfig> =>
  Effect.gen(function* () {
    const resource = yield* effectFetch<{
      Identifier: string;
      TypeName: string;
      ResourceDescription: {
        Properties: string;
      };
    }>("GetResource", {
      TypeName: typeName,
      Identifier: identifier,
    }).pipe(
      Effect.retry(retrySchedule),
      Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined))
    );

    if (!resource) {
      return undefined;
    }

    return JSON.parse(resource.ResourceDescription.Properties) as Record<string, unknown>;
  });

/**
 * Update a resource using Effect
 */
export const updateResource = (
  typeName: string,
  identifier: string,
  patchDocument: Record<string, unknown>,
): Effect.Effect<ProgressEvent, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ResourceNotFoundException | ConcurrentOperationError | UpdateFailedError | AlreadyExistsError | NotFoundError, CloudControlConfig> =>
  Effect.gen(function* () {
    const { ProgressEvent } = yield* effectFetch<{ ProgressEvent: ProgressEvent }>("UpdateResource", {
      TypeName: typeName,
      Identifier: identifier,
      PatchDocument: JSON.stringify(patchDocument),
    }).pipe(Effect.retry(retrySchedule));

    return yield* poll(ProgressEvent.RequestToken, "UpdateResource");
  });

/**
 * Delete a resource using Effect
 */
export const deleteResource = (
  typeName: string,
  identifier: string,
): Effect.Effect<ProgressEvent, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ResourceNotFoundException | ConcurrentOperationError | UpdateFailedError | NotFoundError, CloudControlConfig> =>
  Effect.gen(function* () {
    const { ProgressEvent } = yield* effectFetch<{ ProgressEvent: ProgressEvent }>("DeleteResource", {
      TypeName: typeName,
      Identifier: identifier,
    }).pipe(Effect.retry(retrySchedule));

    return yield* poll(ProgressEvent.RequestToken, "DeleteResource");
  });

/**
 * List resources using Effect
 */
export const listResources = (
  typeName: string,
  nextToken?: string,
): Effect.Effect<{
  ResourceDescriptions: Array<{
    Identifier: string;
    Properties: Record<string, unknown>;
  }>;
  NextToken?: string;
}, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ResourceNotFoundException | ConcurrentOperationError, CloudControlConfig> =>
  effectFetch<{
    ResourceDescriptions: Array<{
      Identifier: string;
      Properties: Record<string, unknown>;
    }>;
    NextToken?: string;
  }>("ListResources", {
    TypeName: typeName,
    NextToken: nextToken,
  }).pipe(Effect.retry(retrySchedule));

/**
 * Poll an operation until completion using Effect
 */
export const poll = (
  requestToken: string,
  action?: "CreateResource" | "UpdateResource" | "DeleteResource",
): Effect.Effect<ProgressEvent, CloudControlError | NetworkError | RequestError | ThrottlingException | ValidationException | ResourceNotFoundException | ConcurrentOperationError | UpdateFailedError | AlreadyExistsError | NotFoundError, CloudControlConfig> =>
  Effect.gen(function* () {
    const config = yield* CloudControlConfig;
    
    const pollOnce = effectFetch<{ ProgressEvent: ProgressEvent }>("GetResourceRequestStatus", {
      RequestToken: requestToken,
    }).pipe(
      Effect.retry(retrySchedule),
      Effect.catchTag("NotFoundError", (error) => 
        action === "DeleteResource" 
          ? Effect.succeed({ ProgressEvent: error.progressEvent })
          : Effect.fail(error)
      )
    );

    const checkProgress = (progressEvent: ProgressEvent): Effect.Effect<ProgressEvent, UpdateFailedError | AlreadyExistsError | NotFoundError, never> => {
      if (progressEvent.OperationStatus === "SUCCESS") {
        return Effect.succeed(progressEvent);
      }

      if (progressEvent.OperationStatus === "FAILED") {
        const errorCode = progressEvent.ErrorCode;
        if (errorCode === "AlreadyExists") {
          return Effect.fail(new AlreadyExistsError({ progressEvent }));
        } else if (errorCode === "NotFound") {
          return Effect.fail(new NotFoundError({ progressEvent }));
        }
        return Effect.fail(new UpdateFailedError({ progressEvent }));
      }

      // Continue polling
      return Effect.fail("continue");
    };

    let logged = false;
    const pollWithBackoff = Effect.gen(function* () {
      const { ProgressEvent } = yield* pollOnce;
      
      const result = yield* checkProgress(ProgressEvent).pipe(
        Effect.catchAll(() => Effect.succeed("continue" as const))
      );

      if (result !== "continue") {
        return result;
      }

      // Log polling status once
      if (!logged) {
        logged = true;
        console.log(
          `Polling for ${ProgressEvent.Identifier} (${ProgressEvent.TypeName}) to stabilize`
        );
      }

      // Calculate delay (use RetryAfter if provided, otherwise exponential backoff)
      const waitTime = ProgressEvent.RetryAfter
        ? Math.max(100, ProgressEvent.RetryAfter * 1000 - Date.now())
        : config.initialPollingDelay;

      yield* Effect.sleep(Duration.millis(waitTime));
      
      return "continue" as const;
    });

    // Poll until completion with exponential backoff
    const pollSchedule = Schedule.exponential(Duration.millis(config.initialPollingDelay)).pipe(
      Schedule.intersect(Schedule.recurs(100)), // Max 100 polling attempts
      Schedule.whileOutput((result: ProgressEvent | "continue") => result === "continue")
    );

    return yield* pollWithBackoff.pipe(
      Effect.repeat(pollSchedule),
      Effect.map((result) => result === "continue" ? 
        Effect.fail(new TimeoutError({ message: "Polling timeout exceeded" })) :
        Effect.succeed(result)
      ),
      Effect.flatten
    );
  });

/**
 * Create CloudControl configuration layer
 */
export const makeCloudControlConfig = (
  options: CloudControlOptions = {},
): Effect.Effect<Layer.Layer<CloudControlConfig, never, never>, Error, never> =>
  Effect.gen(function* () {
    const credentials = yield* Effect.tryPromise(() => fromNodeProviderChain()());
    
    const getRegion = loadConfig({
      environmentVariableSelector: (env) => env.AWS_REGION || env.AWS_DEFAULT_REGION,
      configFileSelector: (profile) => profile.region,
      default: undefined,
    });

    const region =
      options.region ??
      (yield* Effect.tryPromise(() => getRegion()).pipe(Effect.orElse(() => Effect.succeed(undefined)))) ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION;

    if (!region) {
      return yield* Effect.fail(
        new Error(
          "No region found. Please set AWS_REGION or AWS_DEFAULT_REGION in the environment or in your AWS profile."
        )
      );
    }

    const client = new AwsClient({
      ...credentials,
      service: "cloudcontrolapi",
      region,
    });

    const config = {
      client,
      region,
      initialPollingDelay: options.initialPollingDelay || 1000,
      maxPollingDelay: options.maxPollingDelay || 10000,
      maxRetries: options.maxRetries || 3,
    };

    return Layer.succeed(CloudControlConfig, config);
  }).pipe(Effect.flatten);

/**
 * Convenience function to run CloudControl operations with default config
 */
export const runWithCloudControl = <A, E>(
  effect: Effect.Effect<A, E, CloudControlConfig>,
  options?: CloudControlOptions,
): Effect.Effect<A, E | Error, never> =>
  effect.pipe(
    Effect.provide(makeCloudControlConfig(options)),
    Effect.flatten
  );