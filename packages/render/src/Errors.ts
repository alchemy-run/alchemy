import { UserFacingError } from "alchemy/UserFacingError";
import * as Data from "effect/Data";

export type RenderErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 406
  | 409
  | 410
  | 422
  | 429
  | (number & {});

export class RenderBadRequestError extends Data.TaggedError("RenderBadRequestError")<{
  readonly status: 400;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderUnauthorizedError extends Data.TaggedError("RenderUnauthorizedError")<{
  readonly status: 401;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export class RenderPaymentRequiredError extends Data.TaggedError("RenderPaymentRequiredError")<{
  readonly status: 402;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export class RenderForbiddenError extends Data.TaggedError("RenderForbiddenError")<{
  readonly status: 403;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export class RenderNotFoundError extends Data.TaggedError("RenderNotFoundError")<{
  readonly status: 404;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderNotAcceptableError extends Data.TaggedError("RenderNotAcceptableError")<{
  readonly status: 406;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderConflictError extends Data.TaggedError("RenderConflictError")<{
  readonly status: 409;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderGoneError extends Data.TaggedError("RenderGoneError")<{
  readonly status: 410;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderUnprocessableEntityError extends Data.TaggedError(
  "RenderUnprocessableEntityError",
)<{
  readonly status: 422;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderRateLimitError extends Data.TaggedError("RenderRateLimitError")<{
  readonly status: 429;
  readonly method: string;
  readonly path: string;
  readonly retryAfterSeconds?: number;
  readonly message: string;
}> {}

export class RenderServerError extends Data.TaggedError("RenderServerError")<{
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly code?: string;
  readonly message: string;
}> {}

export class RenderTransportError extends Data.TaggedError("RenderTransportError")<{
  readonly method: string;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RenderSchemaError extends Data.TaggedError("RenderSchemaError")<{
  readonly method: string;
  readonly path: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RenderOperationTimeoutError extends Data.TaggedError("RenderOperationTimeoutError")<{
  readonly operation: string;
  readonly resourceId: string;
  readonly attempts: number;
  readonly lastStatus?: string;
  readonly message: string;
}> {}

export class RenderDeployFailedError extends Data.TaggedError("RenderDeployFailedError")<{
  readonly resourceType: string;
  readonly resourceId: string;
  readonly status: string;
  readonly message: string;
}> {}

export class RenderOwnerResolutionError extends Data.TaggedError("RenderOwnerResolutionError")<{
  readonly ownerCount: number;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export class RenderValidationError extends Data.TaggedError("RenderValidationError")<{
  readonly field: string;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

export class RenderTaskRunFailedError extends Data.TaggedError("RenderTaskRunFailedError")<{
  readonly taskRunId: string;
  readonly task: string;
  readonly status: string;
  readonly message: string;
}> {}

export type RenderApiError =
  | RenderBadRequestError
  | RenderUnauthorizedError
  | RenderPaymentRequiredError
  | RenderForbiddenError
  | RenderNotFoundError
  | RenderNotAcceptableError
  | RenderConflictError
  | RenderGoneError
  | RenderUnprocessableEntityError
  | RenderRateLimitError
  | RenderServerError
  | RenderTransportError
  | RenderSchemaError;
