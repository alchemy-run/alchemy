import * as AVP from "@distilled.cloud/aws/verifiedpermissions";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { PolicyStore } from "./PolicyStore.ts";

export interface IsAuthorizedRequest extends Omit<AVP.IsAuthorizedInput, "policyStoreId"> {}
export interface IsAuthorizedWithTokenRequest extends Omit<
  AVP.IsAuthorizedWithTokenInput,
  "policyStoreId"
> {}
export interface BatchIsAuthorizedRequest extends Omit<
  AVP.BatchIsAuthorizedInput,
  "policyStoreId"
> {}
export interface BatchIsAuthorizedWithTokenRequest extends Omit<
  AVP.BatchIsAuthorizedWithTokenInput,
  "policyStoreId"
> {}

/**
 * The runtime authorization client returned by binding `IsAuthorized` to a
 * `PolicyStore`. Each method injects the store's `policyStoreId`
 * automatically.
 */
export interface IsAuthorizedClient {
  /**
   * Make a single authorization decision (`Allow` / `Deny`) for a principal,
   * action, and resource against the store's policies.
   */
  isAuthorized(
    request: IsAuthorizedRequest,
  ): Effect.Effect<AVP.IsAuthorizedOutput, AVP.IsAuthorizedError>;
  /**
   * Make an authorization decision where the principal is derived from a JWT
   * (identity or access token) issued by a configured identity source.
   */
  isAuthorizedWithToken(
    request: IsAuthorizedWithTokenRequest,
  ): Effect.Effect<AVP.IsAuthorizedWithTokenOutput, AVP.IsAuthorizedWithTokenError>;
  /**
   * Make up to 30 authorization decisions in one call, sharing one principal
   * or one resource across the batch.
   */
  batchIsAuthorized(
    request: BatchIsAuthorizedRequest,
  ): Effect.Effect<AVP.BatchIsAuthorizedOutput, AVP.BatchIsAuthorizedError>;
  /**
   * Make up to 30 authorization decisions in one call for the principal
   * derived from a JWT (identity or access token) issued by a configured
   * identity source.
   */
  batchIsAuthorizedWithToken(
    request: BatchIsAuthorizedWithTokenRequest,
  ): Effect.Effect<AVP.BatchIsAuthorizedWithTokenOutput, AVP.BatchIsAuthorizedWithTokenError>;
}

/**
 * Runtime binding for Verified Permissions authorization — bind it to a
 * `PolicyStore` inside a function runtime to get a client that evaluates
 * authorization requests against the store's Cedar policies.
 *
 * This is the effectful-function DX for authorization: a Lambda calls
 * `isAuthorized(...)` and Verified Permissions returns `Allow` or `Deny`
 * along with the determining policies.
 * ### Authorizing Requests
 * **Example:** Decide a Request in a Lambda
 * ```typescript
 * // init
 * const authz = yield* AWS.VerifiedPermissions.IsAuthorized(store);
 *
 * // runtime
 * const { decision } = yield* authz.isAuthorized({
 *   principal: { entityType: "PhotoApp::User", entityId: "alice" },
 *   action: { actionType: "PhotoApp::Action", actionId: "viewPhoto" },
 *   resource: { entityType: "PhotoApp::Photo", entityId: "vacation.jpg" },
 * });
 * // decision === "ALLOW" | "DENY"
 * ```
 *
 * **Example:** Decide from a JWT
 * ```typescript
 * const { decision } = yield* authz.isAuthorizedWithToken({
 *   identityToken,
 *   action: { actionType: "PhotoApp::Action", actionId: "viewPhoto" },
 *   resource: { entityType: "PhotoApp::Photo", entityId: "vacation.jpg" },
 * });
 * ```
 *
 * @binding
 */
export interface IsAuthorized extends Binding.Service<
  IsAuthorized,
  "AWS.VerifiedPermissions.IsAuthorized",
  <S extends PolicyStore>(store: S) => Effect.Effect<IsAuthorizedClient>
> {}
export const IsAuthorized = Binding.Service<IsAuthorized>("AWS.VerifiedPermissions.IsAuthorized");

export const IsAuthorizedHttp = Layer.effect(
  IsAuthorized,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const isAuthorized = yield* AWSBindings.withCredentials(AVP.isAuthorized);
    const isAuthorizedWithToken = yield* AWSBindings.withCredentials(AVP.isAuthorizedWithToken);
    const batchIsAuthorized = yield* AWSBindings.withCredentials(AVP.batchIsAuthorized);
    const batchIsAuthorizedWithToken = yield* AWSBindings.withCredentials(
      AVP.batchIsAuthorizedWithToken,
    );

    return Effect.fn(function* <S extends PolicyStore>(store: S) {
      const PolicyStoreId = yield* store.policyStoreId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.VerifiedPermissions.IsAuthorized(${store})`({
          policyStatements: [
            {
              Effect: "Allow",
              // the batch operations authorize under the non-batch
              // verifiedpermissions:IsAuthorized[WithToken] actions
              Action: [
                "verifiedpermissions:IsAuthorized",
                "verifiedpermissions:IsAuthorizedWithToken",
                "verifiedpermissions:BatchIsAuthorized",
                "verifiedpermissions:BatchIsAuthorizedWithToken",
              ],
              Resource: [store.policyStoreArn],
            },
          ],
        });
      }
      const label = store.LogicalId;
      return {
        isAuthorized: Effect.fn(`AWS.VerifiedPermissions.IsAuthorized(${label})`)(function* (
          request: IsAuthorizedRequest,
        ) {
          const policyStoreId = yield* PolicyStoreId;
          return yield* isAuthorized({ ...request, policyStoreId });
        }),
        isAuthorizedWithToken: Effect.fn(`AWS.VerifiedPermissions.IsAuthorizedWithToken(${label})`)(
          function* (request: IsAuthorizedWithTokenRequest) {
            const policyStoreId = yield* PolicyStoreId;
            return yield* isAuthorizedWithToken({ ...request, policyStoreId });
          },
        ),
        batchIsAuthorized: Effect.fn(`AWS.VerifiedPermissions.BatchIsAuthorized(${label})`)(
          function* (request: BatchIsAuthorizedRequest) {
            const policyStoreId = yield* PolicyStoreId;
            return yield* batchIsAuthorized({ ...request, policyStoreId });
          },
        ),
        batchIsAuthorizedWithToken: Effect.fn(
          `AWS.VerifiedPermissions.BatchIsAuthorizedWithToken(${label})`,
        )(function* (request: BatchIsAuthorizedWithTokenRequest) {
          const policyStoreId = yield* PolicyStoreId;
          return yield* batchIsAuthorizedWithToken({
            ...request,
            policyStoreId,
          });
        }),
      };
    });
  }),
);
