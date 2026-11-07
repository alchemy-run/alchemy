import * as ci from "@distilled.cloud/aws/cognito-identity";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { IdentityPool } from "./IdentityPool.ts";

export interface GetIdRequest extends Omit<ci.GetIdInput, "IdentityPoolId"> {}

/**
 * The typed client returned by binding {@link IdentityPoolAuth} to an
 * `IdentityPool`. `getId` automatically injects the identity pool ID; the
 * remaining calls operate on the returned identity ID.
 */
export interface IdentityPoolAuthClient {
  /** Mint (or look up) an identity ID for a set of logins — or for a guest
   * when the pool allows unauthenticated identities. */
  getId: (request?: GetIdRequest) => Effect.Effect<ci.GetIdResponse, ci.GetIdError>;
  /** Exchange an identity ID (+ logins) for temporary AWS credentials. */
  getCredentialsForIdentity: (
    request: ci.GetCredentialsForIdentityInput,
  ) => Effect.Effect<ci.GetCredentialsForIdentityResponse, ci.GetCredentialsForIdentityError>;
  /** Exchange an identity ID (+ logins) for an OpenID Connect token
   * (basic/classic flow — requires `allowClassicFlow`). */
  getOpenIdToken: (
    request: ci.GetOpenIdTokenInput,
  ) => Effect.Effect<ci.GetOpenIdTokenResponse, ci.GetOpenIdTokenError>;
  /** Unlink a federated login from an identity. */
  unlinkIdentity: (
    request: ci.UnlinkIdentityInput,
  ) => Effect.Effect<ci.UnlinkIdentityResponse, ci.UnlinkIdentityError>;
}

/**
 * Runtime binding for the public (token-based) Cognito identity pool flows —
 * the credentials-vending data plane.
 *
 * Bind this to an `IdentityPool` inside a function runtime to exchange user
 * pool / social / OIDC tokens (or nothing, for guest access) for an identity
 * ID and temporary AWS credentials. These operations are unauthenticated
 * (Cognito does not evaluate IAM for them), so the binding grants no IAM
 * policy — it injects the identity pool ID into `getId`.
 * ### Vending AWS Credentials
 * **Example:** Guest (Unauthenticated) Credentials
 * ```typescript
 * const identity = yield* Cognito.IdentityPoolAuth(identityPool);
 *
 * const { IdentityId } = yield* identity.getId();
 * const creds = yield* identity.getCredentialsForIdentity({
 *   IdentityId: IdentityId!,
 * });
 * ```
 *
 * **Example:** Credentials for a User Pool Sign-In
 * ```typescript
 * const provider = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;
 * const { IdentityId } = yield* identity.getId({
 *   Logins: { [provider]: idToken },
 * });
 * const creds = yield* identity.getCredentialsForIdentity({
 *   IdentityId: IdentityId!,
 *   Logins: { [provider]: idToken },
 * });
 * ```
 *
 * @binding
 */
export interface IdentityPoolAuth extends Binding.Service<
  IdentityPoolAuth,
  "AWS.Cognito.IdentityPoolAuth",
  <P extends IdentityPool>(pool: P) => Effect.Effect<IdentityPoolAuthClient>
> {}
export const IdentityPoolAuth = Binding.Service<IdentityPoolAuth>("AWS.Cognito.IdentityPoolAuth");

/**
 * HTTP implementation of {@link IdentityPoolAuth}. The credentials-vending
 * flows are unauthenticated (Cognito does not evaluate IAM for them), so the
 * deploy-time half only records the binding — no policy statements are
 * attached.
 */
export const IdentityPoolAuthHttp = Layer.effect(
  IdentityPoolAuth,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getId = yield* AWSBindings.withCredentials(ci.getId);
    const getCredentialsForIdentity = yield* AWSBindings.withCredentials(
      ci.getCredentialsForIdentity,
    );
    const getOpenIdToken = yield* AWSBindings.withCredentials(ci.getOpenIdToken);
    const unlinkIdentity = yield* AWSBindings.withCredentials(ci.unlinkIdentity);

    return Effect.fn(function* <P extends IdentityPool>(pool: P) {
      const IdentityPoolId = yield* pool.identityPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // No IAM is required for the public identity flows; the binding is
        // recorded so the identity pool deploys before the function.
        yield* bind`AWS.Cognito.IdentityPoolAuth(${pool})`({
          policyStatements: [],
        });
      }
      const methods = cognitoMethods("AWS.Cognito.IdentityPoolAuth", pool.LogicalId);
      const authClient: IdentityPoolAuthClient = {
        // optional-request operation stays bespoke (the helper's wrapped
        // methods take a required request object)
        getId: Effect.fn(`AWS.Cognito.IdentityPoolAuth.getId(${pool.LogicalId})`)(function* (
          request: GetIdRequest = {},
        ) {
          return yield* getId({
            ...request,
            IdentityPoolId: yield* IdentityPoolId,
          });
        }),
        getCredentialsForIdentity: methods.plain(
          "getCredentialsForIdentity",
          getCredentialsForIdentity,
        ),
        getOpenIdToken: methods.plain("getOpenIdToken", getOpenIdToken),
        unlinkIdentity: methods.plain("unlinkIdentity", unlinkIdentity),
      };
      return authClient;
    });
  }),
);
