import * as ecr from "@distilled.cloud/aws/ecr";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";

/**
 * Runtime binding for `ecr:GetAuthorizationToken`.
 *
 * Mints the temporary registry credential (`AWS:<password>` base64 token,
 * valid 12 hours) a Docker client presents to the account's private ECR
 * registry — a registry-level operation, so the binding takes no resource
 * and the grant is on `Resource: ["*"]` (the action supports no
 * resource-level permissions). Provide the implementation with
 * `Effect.provide(AWS.ECR.GetAuthorizationTokenHttp)`.
 *
 * The returned `authorizationToken` is wrapped in `Redacted` so it never
 * leaks into logs — unwrap with `Redacted.value(...)` at the point of use.
 *
 * ### Registry Authentication
 * **Example:** Decode Docker Login Credentials
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * // init — registry-level binding takes no resource
 * const getAuthorizationToken = yield* AWS.ECR.GetAuthorizationToken();
 *
 * // runtime
 * const res = yield* getAuthorizationToken();
 * const data = res.authorizationData?.[0];
 * const token = data?.authorizationToken;
 * const decoded = Buffer.from(
 *   Redacted.isRedacted(token) ? Redacted.value(token) : (token ?? ""),
 *   "base64",
 * ).toString("utf8"); // "AWS:<password>" for `docker login`
 * ```
 *
 * @binding
 */
export interface GetAuthorizationToken extends Binding.Service<
  GetAuthorizationToken,
  "AWS.ECR.GetAuthorizationToken",
  () => Effect.Effect<
    () => Effect.Effect<ecr.GetAuthorizationTokenResponse, ecr.GetAuthorizationTokenError>
  >
> {}

export const GetAuthorizationToken = Binding.Service<GetAuthorizationToken>(
  "AWS.ECR.GetAuthorizationToken",
);

/**
 * HTTP implementation of {@link GetAuthorizationToken} over the ECR API.
 * Registry-level (not repository-scoped): the token authorizes Docker
 * `login` against the whole private registry, and `ecr:GetAuthorizationToken`
 * supports no resource-level permissions, so the grant is on `"*"`.
 */
export const GetAuthorizationTokenHttp = Layer.effect(
  GetAuthorizationToken,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(ecr.getAuthorizationToken);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ECR.GetAuthorizationToken()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["ecr:GetAuthorizationToken"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.ECR.GetAuthorizationToken")(function* () {
        return yield* op({});
      });
    });
  }),
);
