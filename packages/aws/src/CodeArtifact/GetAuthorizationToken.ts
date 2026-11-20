import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Binding from "alchemy/Binding";
import { toWireSeconds } from "alchemy/Util/Duration";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Domain } from "./Domain.ts";

/**
 * Request for {@link GetAuthorizationToken} — `domain` and `domainOwner` are
 * injected from the bound {@link Domain}.
 */
export interface GetAuthorizationTokenRequest {
  /**
   * How long the token remains valid. Between 15 minutes and 12 hours, or
   * exactly `0` to match the remaining duration of the caller's role session.
   * @default 12 hours
   */
  duration?: Duration.Input;
}

/**
 * Runtime binding for `codeartifact:GetAuthorizationToken`.
 *
 * Mints a temporary authorization token for the bound domain — the credential
 * package managers (npm, pip, maven, …) present to a CodeArtifact repository
 * endpoint. The deploy-time half grants `codeartifact:GetAuthorizationToken`
 * on the domain plus the `sts:GetServiceBearerToken` call CodeArtifact
 * performs on the caller's behalf. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.GetAuthorizationTokenHttp)`.
 *
 * The returned `authorizationToken` is wrapped in `Redacted` so it never
 * leaks into logs — unwrap with `Redacted.value(...)` at the point of use.
 *
 * ### Authenticating Package Managers
 * **Example:** Mint a Token for npm
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const getToken = yield* AWS.CodeArtifact.GetAuthorizationToken(domain);
 *
 * const res = yield* getToken({ duration: "1 hour" });
 * const token = Redacted.isRedacted(res.authorizationToken)
 *   ? Redacted.value(res.authorizationToken)
 *   : res.authorizationToken; // pass to `npm config set //…:_authToken=`
 * ```
 *
 * @binding
 */
export interface GetAuthorizationToken extends Binding.Service<
  GetAuthorizationToken,
  "AWS.CodeArtifact.GetAuthorizationToken",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request?: GetAuthorizationTokenRequest,
    ) => Effect.Effect<
      codeartifact.GetAuthorizationTokenResult,
      codeartifact.GetAuthorizationTokenError
    >
  >
> {}

export const GetAuthorizationToken = Binding.Service<GetAuthorizationToken>(
  "AWS.CodeArtifact.GetAuthorizationToken",
);

/**
 * HTTP implementation of {@link GetAuthorizationToken} over the CodeArtifact
 * API. Domain-scoped (not repository-scoped): tokens authorize against every
 * repository in the domain, and CodeArtifact exchanges the caller's
 * credentials via `sts:GetServiceBearerToken`.
 */
export const GetAuthorizationTokenHttp = Layer.effect(
  GetAuthorizationToken,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(codeartifact.getAuthorizationToken);

    return Effect.fn(function* (domain: Domain) {
      const DomainName = yield* domain.domainName;
      const Owner = yield* domain.owner;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CodeArtifact.GetAuthorizationToken(${domain})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["codeartifact:GetAuthorizationToken"],
              Resource: [domain.domainArn],
            },
            {
              // CodeArtifact exchanges the caller's credentials for the
              // bearer token through STS on the caller's behalf.
              Effect: "Allow",
              Action: ["sts:GetServiceBearerToken"],
              Resource: ["*"],
              Condition: {
                StringEquals: {
                  "sts:AWSServiceName": "codeartifact.amazonaws.com",
                },
              },
            },
          ],
        });
      }
      return Effect.fn(`AWS.CodeArtifact.GetAuthorizationToken(${domain.LogicalId})`)(function* (
        request?: GetAuthorizationTokenRequest,
      ) {
        const owner = yield* Owner;
        return yield* op({
          domain: yield* DomainName,
          ...(owner === "" ? {} : { domainOwner: owner }),
          durationSeconds: toWireSeconds(request?.duration),
        });
      });
    });
  }),
);
