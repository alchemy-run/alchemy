/**
 * Neon Realtime management operations.
 *
 * Neon added the Realtime endpoints to its OpenAPI document on 2026-10-15;
 * `@distilled.cloud/neon` is still generated from the 2026-10-03 snapshot of
 * the spec mirror. These declarations are exactly what the distilled
 * generator emits for the new spec — same operation names, request/response
 * shapes and error channels — so that once the SDK's spec mirror is bumped
 * this module is deleted and `Realtime.ts` imports the operations from
 * `@distilled.cloud/neon` instead.
 *
 * Every operation is `x-stability-level: beta` on Neon's side.
 *
 * @see https://neon.com/docs/reference/api (tag "Realtime")
 * @internal
 */
import * as API from "@distilled.cloud/core/api";
import * as S from "@distilled.cloud/core/schema";
import { UnknownNeonError } from "@distilled.cloud/neon/Errors";
import { NeonProtocol, type NeonOpContext, type NeonOpError } from "@distilled.cloud/neon/Protocol";
import * as Retry from "@distilled.cloud/neon/Retry";
import * as T from "@distilled.cloud/neon/Traits";
import type * as Redacted from "effect/Redacted";

export type RealtimeAllowedOriginsList = Array<string>;
export const RealtimeAllowedOriginsList = /*@__PURE__*/ S.Array(
  S.String,
) as any as S.Codec<RealtimeAllowedOriginsList>;

export interface GetProjectBranchRealtimeRequest {
  /** The project ID */
  project_id: string;
  /** The branch ID */
  branch_id: string;
}
export const GetProjectBranchRealtimeRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    project_id: S.String.pipe(T.Label()),
    branch_id: S.String.pipe(T.Label()),
  }).pipe(
    T.Http({
      method: "GET",
      uri: "/projects/{project_id}/branches/{branch_id}/realtime",
      code: 200,
    }),
  ),
).annotate({
  identifier: "GetProjectBranchRealtimeRequest",
}) as any as S.Codec<GetProjectBranchRealtimeRequest>;

export interface Realtime {
  /** Whether Realtime is enabled for the branch. */
  enabled: boolean;
  /** Whether a provisioning, settings, rotation or deprovisioning change is still being applied. */
  pending: boolean;
  invocation_url?: string;
  revision?: number;
  allowed_origins?: RealtimeAllowedOriginsList;
}
export const Realtime = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    enabled: S.Boolean,
    pending: S.Boolean,
    invocation_url: S.optional(S.String),
    revision: S.optional(S.Number),
    allowed_origins: S.optional(RealtimeAllowedOriginsList),
  }),
).annotate({ identifier: "Realtime" }) as any as S.Codec<Realtime>;

export interface EnableProjectBranchRealtimeRequest {
  /** The project ID */
  project_id: string;
  /** The branch ID */
  branch_id: string;
  /** The browser origins allowed to connect, each `http` or `https` with a host and optional port and no path. An empty list, or `*` alone, allows any origin. Omitted keeps the current or inherited value. */
  allowed_origins?: RealtimeAllowedOriginsList;
}
export const EnableProjectBranchRealtimeRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    project_id: S.String.pipe(T.Label()),
    branch_id: S.String.pipe(T.Label()),
    allowed_origins: S.optional(RealtimeAllowedOriginsList),
  }).pipe(
    T.Http({
      method: "POST",
      uri: "/projects/{project_id}/branches/{branch_id}/realtime",
      code: 200,
    }),
  ),
).annotate({
  identifier: "EnableProjectBranchRealtimeRequest",
}) as any as S.Codec<EnableProjectBranchRealtimeRequest>;

export interface EnableProjectBranchRealtimeResponse {}
export const EnableProjectBranchRealtimeResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}),
).annotate({
  identifier: "EnableProjectBranchRealtimeResponse",
}) as any as S.Codec<EnableProjectBranchRealtimeResponse>;

export interface DisableProjectBranchRealtimeRequest {
  /** The project ID */
  project_id: string;
  /** The branch ID */
  branch_id: string;
}
export const DisableProjectBranchRealtimeRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    project_id: S.String.pipe(T.Label()),
    branch_id: S.String.pipe(T.Label()),
  }).pipe(
    T.Http({
      method: "DELETE",
      uri: "/projects/{project_id}/branches/{branch_id}/realtime",
      code: 200,
    }),
  ),
).annotate({
  identifier: "DisableProjectBranchRealtimeRequest",
}) as any as S.Codec<DisableProjectBranchRealtimeRequest>;

export interface DisableProjectBranchRealtimeResponse {}
export const DisableProjectBranchRealtimeResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}),
).annotate({
  identifier: "DisableProjectBranchRealtimeResponse",
}) as any as S.Codec<DisableProjectBranchRealtimeResponse>;

export interface GetProjectBranchRealtimeSecretRequest {
  /** The project ID */
  project_id: string;
  /** The branch ID */
  branch_id: string;
}
export const GetProjectBranchRealtimeSecretRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    project_id: S.String.pipe(T.Label()),
    branch_id: S.String.pipe(T.Label()),
  }).pipe(
    T.Http({
      method: "GET",
      uri: "/projects/{project_id}/branches/{branch_id}/realtime/secret",
      code: 200,
    }),
  ),
).annotate({
  identifier: "GetProjectBranchRealtimeSecretRequest",
}) as any as S.Codec<GetProjectBranchRealtimeSecretRequest>;

export interface RealtimeSecret {
  /** The key the application backend issues Realtime tokens with, `nrt_live_1` followed by the unpadded base64url 32-byte AES-256-GCM key. */
  secret: string | Redacted.Redacted<string>;
  /** Whether a change is still being applied. After a rotation, the secret changes when this becomes false. */
  pending: boolean;
}
export const RealtimeSecret = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    secret: S.Union([S.String, S.Redacted(S.String, { disallowJsonEncode: true })]).pipe(
      T.SensitiveValue({}),
    ),
    pending: S.Boolean,
  }),
).annotate({ identifier: "RealtimeSecret" }) as any as S.Codec<RealtimeSecret>;

export interface RotateProjectBranchRealtimeSecretRequest {
  /** The project ID */
  project_id: string;
  /** The branch ID */
  branch_id: string;
}
export const RotateProjectBranchRealtimeSecretRequest = /*@__PURE__*/ S.suspend(() =>
  S.Struct({
    project_id: S.String.pipe(T.Label()),
    branch_id: S.String.pipe(T.Label()),
  }).pipe(
    T.Http({
      method: "POST",
      uri: "/projects/{project_id}/branches/{branch_id}/realtime/rotate_secret",
      code: 200,
    }),
  ),
).annotate({
  identifier: "RotateProjectBranchRealtimeSecretRequest",
}) as any as S.Codec<RotateProjectBranchRealtimeSecretRequest>;

export interface RotateProjectBranchRealtimeSecretResponse {}
export const RotateProjectBranchRealtimeSecretResponse = /*@__PURE__*/ S.suspend(() =>
  S.Struct({}),
).annotate({
  identifier: "RotateProjectBranchRealtimeSecretResponse",
}) as any as S.Codec<RotateProjectBranchRealtimeSecretResponse>;

export type GetProjectBranchRealtimeError = NeonOpError;
/** Retrieve Realtime state Retrieves whether Realtime is enabled for the branch, whether a change is still being applied, and, once provisioned, its invocation URL and allowed origins. The shared secret is returned by `GET /projects/{project_id}/branches/{branch_id}/realtime/secret`. */
export const getProjectBranchRealtime: API.OperationMethod<
  GetProjectBranchRealtimeRequest,
  Realtime,
  GetProjectBranchRealtimeError,
  NeonOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: GetProjectBranchRealtimeRequest,
  output: Realtime,
  errors: [UnknownNeonError],
  protocol: NeonProtocol,
  retry: Retry.Retry,
}));

export type EnableProjectBranchRealtimeError = NeonOpError;
/** Enable Realtime Enables Realtime for the branch, or applies new options to an enabled branch. Provisioning is asynchronous; poll the Realtime state until it is no longer pending. */
export const enableProjectBranchRealtime: API.OperationMethod<
  EnableProjectBranchRealtimeRequest,
  EnableProjectBranchRealtimeResponse,
  EnableProjectBranchRealtimeError,
  NeonOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: EnableProjectBranchRealtimeRequest,
  output: EnableProjectBranchRealtimeResponse,
  errors: [UnknownNeonError],
  protocol: NeonProtocol,
  retry: Retry.Retry,
}));

export type DisableProjectBranchRealtimeError = NeonOpError;
/** Disable Realtime Disables Realtime for the branch and discards its shared secret. Deprovisioning is asynchronous. */
export const disableProjectBranchRealtime: API.OperationMethod<
  DisableProjectBranchRealtimeRequest,
  DisableProjectBranchRealtimeResponse,
  DisableProjectBranchRealtimeError,
  NeonOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: DisableProjectBranchRealtimeRequest,
  output: DisableProjectBranchRealtimeResponse,
  errors: [UnknownNeonError],
  protocol: NeonProtocol,
  retry: Retry.Retry,
}));

export type GetProjectBranchRealtimeSecretError = NeonOpError;
/** Retrieve the Realtime shared secret Retrieves the secret the application backend issues Realtime tokens with. Requires permission to read the project's credentials. Returns 404 while Realtime is disabled or before the secret is provisioned. After a rotation, this returns the previous secret until `pending` is false. */
export const getProjectBranchRealtimeSecret: API.OperationMethod<
  GetProjectBranchRealtimeSecretRequest,
  RealtimeSecret,
  GetProjectBranchRealtimeSecretError,
  NeonOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: GetProjectBranchRealtimeSecretRequest,
  output: RealtimeSecret,
  errors: [UnknownNeonError],
  protocol: NeonProtocol,
  retry: Retry.Retry,
}));

export type RotateProjectBranchRealtimeSecretError = NeonOpError;
/** Rotate the Realtime shared secret Replaces the branch's Realtime shared secret. Rotation is asynchronous: once the Realtime state is no longer pending, the previous secret stops working and `GET /projects/{project_id}/branches/{branch_id}/realtime/secret` returns the new one. */
export const rotateProjectBranchRealtimeSecret: API.OperationMethod<
  RotateProjectBranchRealtimeSecretRequest,
  RotateProjectBranchRealtimeSecretResponse,
  RotateProjectBranchRealtimeSecretError,
  NeonOpContext
> = /*@__PURE__*/ API.make(() => ({
  input: RotateProjectBranchRealtimeSecretRequest,
  output: RotateProjectBranchRealtimeSecretResponse,
  errors: [UnknownNeonError],
  protocol: NeonProtocol,
  retry: Retry.Retry,
}));
