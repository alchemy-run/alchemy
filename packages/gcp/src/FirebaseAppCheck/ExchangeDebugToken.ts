import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { AppsDebugToken } from "./AppsDebugToken.ts";

export interface ExchangeDebugTokenRequest {
  /**
   * When true, the attestation is limited-use (replay protection).
   * @default false
   */
  limitedUse?: boolean;
}

/**
 * Runtime binding for App Check `apps.exchangeDebugToken`.
 *
 * Bind this operation to an {@link AppsDebugToken} in a Function/Action
 * init phase. Provide {@link ExchangeDebugTokenHttp}. The secret is read
 * from Alchemy state (`token` is never returned by get).
 *
 * ### Exchanging a Debug Token
 * **Example:** Mint a session App Check token
 * ```typescript
 * const exchange = yield* GCP.FirebaseAppCheck.ExchangeDebugToken(debug);
 * const { token, ttl } = yield* exchange();
 * ```
 *
 * **Example:** Limited-use token
 * ```typescript
 * const exchange = yield* GCP.FirebaseAppCheck.ExchangeDebugToken(debug);
 * const { token } = yield* exchange({ limitedUse: true });
 * ```
 *
 * @binding
 * @category FirebaseAppCheck
 */
export interface ExchangeDebugToken extends Binding.Service<
  ExchangeDebugToken,
  "GCP.FirebaseAppCheck.ExchangeDebugToken",
  (
    debugToken: AppsDebugToken,
  ) => Effect.Effect<
    (
      request?: ExchangeDebugTokenRequest,
    ) => Effect.Effect<
      firebaseappcheck.GoogleFirebaseAppcheckV1AppCheckToken,
      firebaseappcheck.ExchangeDebugTokenProjectsAppsError,
      RuntimeContext
    >
  >
> {}

export const ExchangeDebugToken = Binding.Service<ExchangeDebugToken>(
  "GCP.FirebaseAppCheck.ExchangeDebugToken",
);

/**
 * HTTP implementation of {@link ExchangeDebugToken}.
 *
 * @layer
 * @provides GCP.FirebaseAppCheck.ExchangeDebugToken
 */
export const ExchangeDebugTokenHttp = Layer.effect(
  ExchangeDebugToken,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const exchange = yield* GCPBindings.withCredentials(
      firebaseappcheck.exchangeDebugTokenProjectsApps,
    );
    return Effect.fn(function* (debugToken: AppsDebugToken) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.FirebaseAppCheck.ExchangeDebugToken(${debugToken})`({
          // exchangeDebugToken is not IAM-gated; the debug token secret is the
          // credential.
          iam: [],
        });
      }
      const app = yield* debugToken.app;
      const secret = yield* debugToken.token;
      return Effect.fn(`GCP.FirebaseAppCheck.ExchangeDebugToken(${debugToken.LogicalId})`)(
        function* (request?: ExchangeDebugTokenRequest) {
          return yield* exchange({
            app: yield* app,
            body: {
              debugToken: (yield* secret) ?? "",
              limitedUse: request?.limitedUse === true ? true : undefined,
            },
          });
        },
      );
    });
  }),
);
