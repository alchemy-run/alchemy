import * as Data from "effect/Data";
import * as Brand from "effect/Brand";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import type * as Redacted from "effect/Redacted";
import type { Plan } from "../Plan.ts";

export type OperationId = string & Brand.Brand<"OperationId">;
export type PlanId = string & Brand.Brand<"PlanId">;
export type PlanRevision = string & Brand.Brand<"PlanRevision">;
export type DriftId = string & Brand.Brand<"DriftId">;
export type NukeScanId = string & Brand.Brand<"NukeScanId">;
export type NukeResourceId = string & Brand.Brand<"NukeResourceId">;

export const OperationId = Brand.nominal<OperationId>();
export const PlanId = Brand.nominal<PlanId>();
export const PlanRevision = Brand.nominal<PlanRevision>();
export const DriftId = Brand.nominal<DriftId>();
export const NukeScanId = Brand.nominal<NukeScanId>();
export const NukeResourceId = Brand.nominal<NukeResourceId>();

export const randomUuid = Effect.gen(function* () {
  const bytes = yield* Effect.forEach(Array.from({ length: 16 }), () =>
    Random.nextIntBetween(0, 256),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
});

export const makeOperationId = Effect.map(randomUuid, OperationId);
export const makePlanId = Effect.map(randomUuid, PlanId);
export const makePlanRevision = Effect.map(randomUuid, PlanRevision);
export const makeDriftId = Effect.map(randomUuid, DriftId);
export const makeNukeScanId = Effect.map(randomUuid, NukeScanId);
export const makeNukeResourceId = Effect.map(randomUuid, NukeResourceId);

export interface Diagnostic {
  readonly severity: "debug" | "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly provider: string;
  readonly operation: string;
  readonly error: {
    readonly tag: string;
    readonly message: string;
    readonly code?: string | number;
    readonly retryable?: boolean;
    readonly details?: unknown;
  };
}> {}

export class InvalidControlInput extends Data.TaggedError(
  "InvalidControlInput",
)<{ readonly message: string; readonly field?: string }> {}

export class ControlNotFound extends Data.TaggedError("ControlNotFound")<{
  readonly kind: string;
  readonly id: string;
}> {}

export class ControlConflict extends Data.TaggedError("ControlConflict")<{
  readonly message: string;
}> {}

export class StaleRevision extends Data.TaggedError("StaleRevision")<{
  readonly expected: string;
  readonly actual: string;
}> {}

export class CredentialsRequired extends Data.TaggedError(
  "ControlCredentialsRequired",
)<{ readonly provider: string; readonly message: string }> {}

export class AuthorizationFailed extends Data.TaggedError(
  "ControlAuthorizationFailed",
)<{ readonly provider: string; readonly message: string }> {}

export class ControlInternalError extends Data.TaggedError(
  "ControlInternalError",
)<{ readonly message: string; readonly cause?: unknown }> {}

export type ControlError =
  | InvalidControlInput
  | ControlNotFound
  | ControlConflict
  | StaleRevision
  | CredentialsRequired
  | AuthorizationFailed
  | ControlInternalError
  | ProviderFailure;

export interface StackTarget {
  readonly entrypoint: string;
  readonly stage: string;
  readonly profile?: string;
  readonly envFile?: string;
}

export interface StackIdentity {
  readonly name: string;
  readonly stage: string;
}

export interface ResourceIdentity {
  readonly fqn: string;
  readonly logicalId: string;
  readonly resourceType: string;
}

export interface PlannedResource extends ResourceIdentity {
  readonly action: "create" | "update" | "replace" | "delete" | "noop";
  readonly inputs?: unknown;
  readonly outputs?: unknown;
}

export interface PlanSummary {
  readonly create: number;
  readonly update: number;
  readonly replace: number;
  readonly delete: number;
  readonly noop: number;
}

export interface PlanSnapshot {
  readonly id: PlanId;
  readonly revision: PlanRevision;
  readonly stack: StackIdentity;
  readonly operation: "deploy" | "destroy";
  readonly resources: ReadonlyArray<PlannedResource>;
  readonly summary: PlanSummary;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly createdAt: Date;
  /** Native in-process plan consumed by CLI renderers. */
  readonly native: Plan;
}

export interface StackSnapshot {
  readonly identity: StackIdentity;
  readonly resources: ReadonlyArray<ResourceIdentity>;
  readonly providers: ReadonlyArray<{ readonly name: string }>;
}

export interface PlanStackInput {
  readonly target: StackTarget;
  readonly operation: "deploy" | "destroy";
  readonly force?: boolean;
  readonly adopt?: boolean;
  readonly updateStateStore?: boolean;
}

export type PlanningPhase =
  | "importing-module"
  | "resolving-services"
  | "loading-state"
  | "computing-plan"
  | "plan-ready";

export interface PlanningEvent {
  readonly _tag: "PlanningPhaseChanged";
  readonly phase: PlanningPhase;
  readonly message: string;
}

export interface ApplyPlanInput {
  readonly planId: PlanId;
  readonly revision: PlanRevision;
}

export interface ReconcileDevInput {
  readonly target: StackTarget;
  readonly force?: boolean;
}

export interface ApplyResult {
  readonly stack: StackIdentity;
  readonly outputs: unknown;
  readonly resources: ReadonlyArray<ResourceIdentity>;
}

export interface DriftedResource extends ResourceIdentity {
  readonly status: "in-sync" | "drifted" | "missing";
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface DriftSnapshot {
  readonly id: DriftId;
  readonly revision: string;
  readonly stack: StackIdentity;
  readonly resources: ReadonlyArray<DriftedResource>;
  readonly repairPlan: PlanSnapshot;
}

export interface RepairDriftInput {
  readonly driftId: DriftId;
  readonly revision: string;
}

export interface LogResource extends ResourceIdentity {
  readonly supportsQuery: boolean;
  readonly supportsTail: boolean;
}

export interface LogEntry {
  readonly resource: ResourceIdentity;
  readonly timestamp: Date;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface QueryLogsInput {
  readonly target: StackTarget;
  readonly resources?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly since?: Date;
}

export interface TailLogsInput {
  readonly target: StackTarget;
  readonly resources?: ReadonlyArray<string>;
}

export interface ProfileSummary {
  readonly name: string;
  readonly active: boolean;
  readonly providers: ReadonlyArray<{
    readonly name: string;
    readonly method: string;
  }>;
}

export interface SelectedProfile {
  readonly name: string;
  readonly source: "explicit" | "configuration" | "default";
}

export interface ProviderConnection {
  readonly name: string;
  readonly method: string;
  readonly status: "connected" | "needs-reauth" | "invalid" | "unavailable";
  readonly details: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
  }>;
  readonly diagnostic?: Diagnostic;
}

export interface ProfileSnapshot {
  readonly name: string;
  readonly active: boolean;
  readonly providers: ReadonlyArray<ProviderConnection>;
}

export interface ConfigureField {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly environment?: ReadonlyArray<string>;
}

export interface ConfigureMethod {
  readonly method: string;
  readonly label: string;
  readonly fields: ReadonlyArray<ConfigureField>;
}

export interface AuthProviderDescriptor {
  readonly name: string;
  readonly connected: boolean;
  readonly configureMethods: ReadonlyArray<ConfigureMethod>;
  readonly supportsRefresh: boolean;
  readonly supportsLogout: boolean;
}

export interface ConfigureProviderInput {
  readonly profile: string;
  readonly provider: string;
  readonly entrypoint?: string;
  readonly envFile?: string;
  readonly action: "add" | "reconfigure";
  readonly method?: string;
  readonly values?: Readonly<Record<string, Redacted.Redacted<string>>>;
}

export interface ProfileGetInput {
  readonly name: string;
  readonly includeProviderStatus?: boolean;
}

export interface ProfileProvidersInput {
  readonly entrypoint?: string;
  readonly envFile?: string;
  readonly profile?: string;
}

export interface ProfileConfigureFormInput {
  readonly profile: string;
  readonly provider: string;
  readonly method?: string;
}

export interface ProfileCreateInput {
  readonly name: string;
}

export interface ProfileRenameInput {
  readonly name: string;
  readonly newName: string;
}

export interface ProfileDeleteInput {
  readonly name: string;
}

export interface ProfileRemoveProviderInput {
  readonly profile: string;
  readonly provider: string;
  readonly entrypoint?: string;
  readonly envFile?: string;
  readonly logout?: boolean;
}

export interface ProfileRefreshInput {
  readonly profile: string;
  readonly entrypoint?: string;
  readonly envFile?: string;
  readonly providers?: ReadonlyArray<string>;
}

export interface ProviderRemoved {
  readonly profile: string;
  readonly provider: string;
  readonly logout: "completed" | "skipped-invalid-config" | "unavailable";
}

export interface ProfileDeleted {
  readonly name: string;
  readonly credentialsDeleted: boolean;
}

export interface ProviderEnvironmentCheck {
  readonly provider: string;
  readonly status: "satisfied" | "missing" | "no-contract";
  readonly missing: ReadonlyArray<{
    readonly alternatives: ReadonlyArray<string>;
  }>;
}

export interface EnvironmentCheckResult {
  readonly checks: ReadonlyArray<ProviderEnvironmentCheck>;
  readonly satisfied: boolean;
}

export interface CheckEnvironmentInput {
  readonly entrypoint?: string;
  readonly envFile?: string;
  readonly profile: string;
  readonly providers?: ReadonlyArray<string>;
}

export interface AwsTarget {
  readonly profile: string;
  readonly region?: string;
  readonly envFile?: string;
}

export interface AwsBootstrapResult {
  readonly accountId: string;
  readonly region: string;
  readonly bucketName: string;
  readonly created: boolean;
}

export interface AwsTeardownResult {
  readonly accountId: string;
  readonly region: string;
  readonly destroyed: ReadonlyArray<string>;
}

export interface CloudflareStateTarget {
  readonly profile: string;
  readonly envFile?: string;
  readonly workerName?: string;
}

export interface CloudflareStateLogsInput extends CloudflareStateTarget {
  readonly limit?: number;
  readonly since?: Date;
}

export interface CloudflareBootstrapInput extends CloudflareStateTarget {
  readonly force?: boolean;
}

export interface CloudflareBootstrapResult {
  readonly accountId: string;
  readonly workerName: string;
  readonly status: "created" | "adopted" | "redeployed";
  readonly credentialsRefreshed: boolean;
  readonly stateStoreVersion?: number;
}

export interface CloudflareTeardownResult {
  readonly accountId: string;
  readonly workerName: string;
  readonly deleted: ReadonlyArray<string>;
}

export interface CloudflareGlobalCredentials {
  readonly email: string;
  readonly apiKey: Redacted.Redacted<string>;
}

export interface CloudflareAccount {
  readonly id: string;
  readonly name: string;
}

export interface CloudflarePermissionGroup {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly selectable: boolean;
}

export interface CloudflareTokenCatalog {
  readonly accounts: ReadonlyArray<CloudflareAccount>;
  readonly permissionGroups: ReadonlyArray<CloudflarePermissionGroup>;
}

export interface CloudflareTokenPlanInput {
  readonly credentials: CloudflareGlobalCredentials;
  readonly name: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly permissionGroupIds: ReadonlyArray<string> | "all";
}

export interface CloudflareTokenPlan {
  readonly name: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly permissionGroupIds: ReadonlyArray<string>;
  readonly permissionCount: number;
  readonly grantsFullAccess: boolean;
  readonly policies: ReadonlyArray<unknown>;
}

export interface CreatedCloudflareToken {
  readonly id: string;
  readonly name: string;
  readonly value: Redacted.Redacted<string>;
  readonly grantedPermissionGroups: number;
  readonly policies: ReadonlyArray<unknown>;
  readonly verificationStatus?: string;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

export interface CloudflareTokenCatalogInput {
  readonly credentials: CloudflareGlobalCredentials;
}

export interface CreateCloudflareTokenInput {
  readonly credentials: CloudflareGlobalCredentials;
  readonly plan: CloudflareTokenPlan;
}

export interface NukeScanInput {
  readonly entrypoint: string;
  readonly profile: string;
  readonly envFile?: string;
  readonly mode: "live" | "local";
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
  readonly concurrency?: number | "unbounded";
  readonly providerTimeoutSeconds?: number;
}

export interface NukeResource {
  readonly id: NukeResourceId;
  readonly providerId: string;
  readonly displayName: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface NukeScan {
  readonly id: NukeScanId;
  readonly revision: string;
  readonly mode: "live" | "local";
  readonly resources: ReadonlyArray<NukeResource>;
  readonly failures: ReadonlyArray<ProviderFailure>;
}

export interface ExecuteNukeInput {
  readonly scanId: NukeScanId;
  readonly revision: string;
  readonly resources: ReadonlyArray<NukeResourceId>;
  readonly strategy:
    | { readonly _tag: "coordinated" }
    | { readonly _tag: "independent"; readonly retries: number };
  readonly concurrency?: number | "unbounded";
  readonly providerTimeoutSeconds?: number;
}

export interface NukeResult {
  readonly requested: number;
  readonly deleted: ReadonlyArray<NukeResourceId>;
  readonly failed: ReadonlyArray<{
    readonly resource: NukeResourceId;
    readonly failure: ProviderFailure;
  }>;
  readonly held: ReadonlyArray<{
    readonly resource: NukeResourceId;
    readonly blockedBy: ReadonlyArray<string>;
  }>;
  readonly passes: number;
}
