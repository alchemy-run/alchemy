import * as ci from "@distilled.cloud/aws/cognito-identity";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { IdentityPool } from "./IdentityPool.ts";

export interface ListIdentitiesRequest extends Omit<ci.ListIdentitiesInput, "IdentityPoolId"> {}
export interface LookupDeveloperIdentityRequest extends Omit<
  ci.LookupDeveloperIdentityInput,
  "IdentityPoolId"
> {}
export interface MergeDeveloperIdentitiesRequest extends Omit<
  ci.MergeDeveloperIdentitiesInput,
  "IdentityPoolId"
> {}
export interface UnlinkDeveloperIdentityRequest extends Omit<
  ci.UnlinkDeveloperIdentityInput,
  "IdentityPoolId"
> {}
export interface GetOpenIdTokenForDeveloperIdentityRequest extends Omit<
  ci.GetOpenIdTokenForDeveloperIdentityInput,
  "IdentityPoolId"
> {}

/**
 * The typed client returned by binding {@link IdentityPoolAdmin} to an
 * `IdentityPool`. Pool-scoped calls automatically inject the identity pool
 * ID and are authorized by IAM (`cognito-identity:*` on the pool's ARN).
 */
export interface IdentityPoolAdminClient {
  /** Fetch an identity's linked logins and metadata. */
  describeIdentity: (
    request: ci.DescribeIdentityInput,
  ) => Effect.Effect<ci.IdentityDescription, ci.DescribeIdentityError>;
  /** Page through the identities registered in the pool. */
  listIdentities: (
    request: ListIdentitiesRequest,
  ) => Effect.Effect<ci.ListIdentitiesResponse, ci.ListIdentitiesError>;
  /** Permanently delete identities from the pool. */
  deleteIdentities: (
    request: ci.DeleteIdentitiesInput,
  ) => Effect.Effect<ci.DeleteIdentitiesResponse, ci.DeleteIdentitiesError>;
  /** Look up an identity by developer user identifier (or vice versa). */
  lookupDeveloperIdentity: (
    request: LookupDeveloperIdentityRequest,
  ) => Effect.Effect<ci.LookupDeveloperIdentityResponse, ci.LookupDeveloperIdentityError>;
  /** Merge two developer-authenticated identities into one. */
  mergeDeveloperIdentities: (
    request: MergeDeveloperIdentitiesRequest,
  ) => Effect.Effect<ci.MergeDeveloperIdentitiesResponse, ci.MergeDeveloperIdentitiesError>;
  /** Unlink a developer user identifier from an identity. */
  unlinkDeveloperIdentity: (
    request: UnlinkDeveloperIdentityRequest,
  ) => Effect.Effect<ci.UnlinkDeveloperIdentityResponse, ci.UnlinkDeveloperIdentityError>;
  /** Mint an OpenID Connect token for a developer-authenticated identity
   * (server-side developer provider flow). */
  getOpenIdTokenForDeveloperIdentity: (
    request: GetOpenIdTokenForDeveloperIdentityRequest,
  ) => Effect.Effect<
    ci.GetOpenIdTokenForDeveloperIdentityResponse,
    ci.GetOpenIdTokenForDeveloperIdentityError
  >;
}

/**
 * Runtime binding for administrative Cognito identity pool operations —
 * identity management and the developer-authenticated identities flow.
 *
 * Bind this to an `IdentityPool` inside a function runtime to get a typed
 * client for listing/deleting identities and for developer-provider token
 * minting. The binding grants the corresponding `cognito-identity:*` IAM
 * actions scoped to the pool's ARN and injects the pool ID into pool-scoped
 * calls.
 * ### Managing Identities
 * **Example:** List and Describe Identities
 * ```typescript
 * const identities = yield* Cognito.IdentityPoolAdmin(identityPool);
 *
 * const page = yield* identities.listIdentities({ MaxResults: 20 });
 * const first = page.Identities?.[0];
 * if (first?.IdentityId) {
 *   const detail = yield* identities.describeIdentity({
 *     IdentityId: first.IdentityId,
 *   });
 * }
 * ```
 *
 * ### Developer-Authenticated Identities
 * **Example:** Mint a Token for a Backend-Authenticated User
 * ```typescript
 * const token = yield* identities.getOpenIdTokenForDeveloperIdentity({
 *   Logins: { "my.developer.provider": userId },
 * });
 * ```
 *
 * @binding
 */
export interface IdentityPoolAdmin extends Binding.Service<
  IdentityPoolAdmin,
  "AWS.Cognito.IdentityPoolAdmin",
  <P extends IdentityPool>(pool: P) => Effect.Effect<IdentityPoolAdminClient>
> {}
export const IdentityPoolAdmin = Binding.Service<IdentityPoolAdmin>(
  "AWS.Cognito.IdentityPoolAdmin",
);

/** The injected identifier field, in the distilled wire type. */
type IdentityPoolIdField = Pick<ci.ListIdentitiesInput, "IdentityPoolId">;

/**
 * HTTP implementation of {@link IdentityPoolAdmin}: grants the
 * `cognito-identity:*` identity-management actions on the bound pool's ARN
 * and calls the Cognito Identity HTTP API with the function's IAM
 * credentials.
 */
export const IdentityPoolAdminHttp = Layer.effect(
  IdentityPoolAdmin,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const describeIdentity = yield* AWSBindings.withCredentials(ci.describeIdentity);
    const listIdentities = yield* AWSBindings.withCredentials(ci.listIdentities);
    const deleteIdentities = yield* AWSBindings.withCredentials(ci.deleteIdentities);
    const lookupDeveloperIdentity = yield* AWSBindings.withCredentials(ci.lookupDeveloperIdentity);
    const mergeDeveloperIdentities = yield* AWSBindings.withCredentials(
      ci.mergeDeveloperIdentities,
    );
    const unlinkDeveloperIdentity = yield* AWSBindings.withCredentials(ci.unlinkDeveloperIdentity);
    const getOpenIdTokenForDeveloperIdentity = yield* AWSBindings.withCredentials(
      ci.getOpenIdTokenForDeveloperIdentity,
    );

    return Effect.fn(function* <P extends IdentityPool>(pool: P) {
      const IdentityPoolId = yield* pool.identityPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Cognito.IdentityPoolAdmin(${pool})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "cognito-identity:GetOpenIdTokenForDeveloperIdentity",
                "cognito-identity:ListIdentities",
                "cognito-identity:LookupDeveloperIdentity",
                "cognito-identity:MergeDeveloperIdentities",
                "cognito-identity:UnlinkDeveloperIdentity",
              ],
              Resource: [pool.identityPoolArn],
            },
            {
              Effect: "Allow",
              // These act on identity IDs, which have no ARN form —
              // Cognito Identity does not support resource-level
              // scoping for them.
              Action: ["cognito-identity:DeleteIdentities", "cognito-identity:DescribeIdentity"],
              Resource: ["*"],
            },
          ],
        });
      }
      const methods = cognitoMethods("AWS.Cognito.IdentityPoolAdmin", pool.LogicalId);
      const withPool = methods.injecting(
        Effect.map(IdentityPoolId, (id): IdentityPoolIdField => ({
          IdentityPoolId: id,
        })),
      );
      const adminClient: IdentityPoolAdminClient = {
        describeIdentity: methods.plain("describeIdentity", describeIdentity),
        deleteIdentities: methods.plain("deleteIdentities", deleteIdentities),
        listIdentities: withPool("listIdentities", listIdentities),
        lookupDeveloperIdentity: withPool("lookupDeveloperIdentity", lookupDeveloperIdentity),
        mergeDeveloperIdentities: withPool("mergeDeveloperIdentities", mergeDeveloperIdentities),
        unlinkDeveloperIdentity: withPool("unlinkDeveloperIdentity", unlinkDeveloperIdentity),
        getOpenIdTokenForDeveloperIdentity: withPool(
          "getOpenIdTokenForDeveloperIdentity",
          getOpenIdTokenForDeveloperIdentity,
        ),
      };
      return adminClient;
    });
  }),
);
