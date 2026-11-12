import type * as service from "@distilled.cloud/clickhouse-cloud/service";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * ClickHouse Cloud answered a call without the `result` its envelope always
 * carries on success, so there is nothing to read the resource from.
 */
export class ResultMissing extends Data.TaggedError("ClickHouseCloud.ResultMissing")<{
  readonly operation: string;
}> {
  override get message() {
    return `ClickHouse Cloud returned no result for ${this.operation}`;
  }
}

/** The payload of a successful `{ status, requestId, result }` envelope, or {@link ResultMissing}. */
export const requireResult =
  (operation: string) =>
  <A>(response: { readonly result?: A | undefined }): Effect.Effect<A, ResultMissing> =>
    response.result === undefined
      ? Effect.fail(new ResultMissing({ operation }))
      : Effect.succeed(response.result);

/** The service reached the `failed` state. */
export class ServiceFailed extends Data.TaggedError("ClickHouseCloud.ServiceFailed")<{
  readonly serviceId: string;
  readonly state: string;
}> {
  override get message() {
    return `ClickHouse Cloud service ${this.serviceId} is in state "${this.state}"`;
  }
}

/** The service did not reach the expected state within the wait budget. */
export class ServiceNotReady extends Data.TaggedError("ClickHouseCloud.ServiceNotReady")<{
  readonly serviceId: string;
  readonly waitingFor: string;
  readonly state: string | undefined;
}> {
  override get message() {
    return `ClickHouse Cloud service ${this.serviceId} did not become ${this.waitingFor} (last state: ${this.state ?? "unknown"})`;
  }
}

/** `deleteService` answered 409: deletion protection is on. */
export class ServiceDeletionProtected extends Data.TaggedError(
  "ClickHouseCloud.ServiceDeletionProtected",
)<{
  readonly serviceId: string;
  readonly serviceName: string;
  /** The API's `DeletionProtectionEnabled` answer. */
  readonly cause: service.DeletionProtectionEnabled;
}> {
  override get message() {
    return (
      `ClickHouse Cloud service "${this.serviceName}" (${this.serviceId}) has deletion protection on. ` +
      "Set `deletionProtection: false` and deploy before deleting it, or turn protection off in the console."
    );
  }
}

/**
 * `createService` answered `InstanceLimitReached`: the organization already
 * has as many services as its plan allows.
 */
export class ServiceLimitReached extends Data.TaggedError("ClickHouseCloud.ServiceLimitReached")<{
  readonly organizationId: string;
  readonly serviceName: string;
  /** The API's `InstanceLimitReached` answer. */
  readonly cause: service.InstanceLimitReached;
}> {
  override get message() {
    return (
      `Cannot create ClickHouse Cloud service "${this.serviceName}": organization ${this.organizationId} ` +
      "already has as many services as its plan allows (INSTANCE_LIMIT_REACHED). Delete a service, or ask " +
      "ClickHouse to raise the `services-per-organization` quota (ClickHouseCloud.Organization.GetOrganizationQuota shows it)."
    );
  }
}

/** A role the resource would manage is a predefined system role. */
export class SystemRoleImmutable extends Data.TaggedError("ClickHouseCloud.SystemRoleImmutable")<{
  readonly roleId: string;
  readonly roleName: string;
}> {
  override get message() {
    return `ClickHouse Cloud role "${this.roleName}" (${this.roleId}) is a system role and cannot be managed`;
  }
}

/** The API key a resource would delete is the one the deploy authenticates with. */
export class ApiKeyInUse extends Data.TaggedError("ClickHouseCloud.ApiKeyInUse")<{
  readonly keyId: string;
}> {
  override get message() {
    return `ClickHouse Cloud API key ${this.keyId} authenticates this deploy and cannot delete itself`;
  }
}

/** A long-running object (UDF build, attachment, ClickPipe, reverse private endpoint) ended in a failed state. */
export class OperationFailed extends Data.TaggedError("ClickHouseCloud.OperationFailed")<{
  readonly kind: string;
  readonly id: string;
  readonly state: string;
  readonly detail?: string | undefined;
}> {
  override get message() {
    return `ClickHouse Cloud ${this.kind} ${this.id} is in state "${this.state}"${this.detail ? `: ${this.detail}` : ""}`;
  }
}

/** A long-running object did not reach a usable state within its wait budget. */
export class OperationTimedOut extends Data.TaggedError("ClickHouseCloud.OperationTimedOut")<{
  readonly kind: string;
  readonly id: string;
  readonly waitingFor: string;
  readonly state: string | undefined;
}> {
  override get message() {
    return `ClickHouse Cloud ${this.kind} ${this.id} did not become ${this.waitingFor} (last state: ${this.state ?? "unknown"})`;
  }
}
