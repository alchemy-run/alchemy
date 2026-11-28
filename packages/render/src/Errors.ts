import { UserFacingError } from "alchemy/UserFacingError";
import * as Data from "effect/Data";

export {
  API_ERRORS,
  BadGateway,
  BadRequest,
  ConfigError,
  Conflict,
  DEFAULT_ERRORS,
  Forbidden,
  GatewayTimeout,
  HTTP_STATUS_MAP,
  InternalServerError,
  Locked,
  NotFound,
  RenderParseError,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnknownRenderError,
  UnprocessableEntity,
  type DefaultErrors,
} from "@distilled.cloud/render";

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
