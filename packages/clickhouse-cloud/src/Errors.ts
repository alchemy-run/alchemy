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

/** A member resource names a user who is not (or no longer) in the organization. */
export class MemberNotFound extends Data.TaggedError("ClickHouseCloud.MemberNotFound")<{
  readonly userId: string;
}> {
  override get message() {
    return (
      `ClickHouse Cloud user ${this.userId} is not a member of the organization. Members join by ` +
      "accepting an invitation (ClickHouseCloud.UserManagement.Invitation); a Member resource can only adopt one."
    );
  }
}

/** The preview a `PreviewFeature` names is not offered to the organization, or cannot be toggled. */
export class PreviewNotOffered extends Data.TaggedError("ClickHouseCloud.PreviewNotOffered")<{
  readonly previewId: string;
  readonly offered: readonly string[];
  readonly reason: "not-offered" | "not-toggleable";
}> {
  override get message() {
    return this.reason === "not-offered"
      ? `ClickHouse Cloud preview "${this.previewId}" is not offered to this organization (offered: ${this.offered.join(", ") || "none"})`
      : `ClickHouse Cloud preview "${this.previewId}" cannot be switched by the organization (canToggle is false)`;
  }
}

/** BYOC validation denied one or more checks for the requested infrastructure. */
export class ByocValidationFailed extends Data.TaggedError("ClickHouseCloud.ByocValidationFailed")<{
  readonly checks: ReadonlyArray<{ readonly name: string; readonly reason: string | undefined }>;
}> {
  override get message() {
    return `ClickHouse Cloud BYOC validation failed: ${this.checks
      .map((c) => `${c.name}${c.reason ? ` (${c.reason})` : ""}`)
      .join("; ")}`;
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

/** A setting the resource needs is not available for this service or organization. */
export class FeatureUnavailable extends Data.TaggedError("ClickHouseCloud.FeatureUnavailable")<{
  readonly feature: string;
  readonly reason: string;
}> {
  override get message() {
    return `ClickHouse Cloud ${this.feature} is not available: ${this.reason}`;
  }
}
