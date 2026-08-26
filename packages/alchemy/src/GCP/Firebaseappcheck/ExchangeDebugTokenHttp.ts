import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { AppsDebugToken } from "./AppsDebugToken.ts";
import {
  ExchangeDebugToken,
  type ExchangeDebugTokenRequest,
} from "./ExchangeDebugToken.ts";

/**
 * HTTP implementation of {@link ExchangeDebugToken}.
 *
 * @layer
 * @provides GCP.Firebaseappcheck.ExchangeDebugToken
 */
export const ExchangeDebugTokenHttp = Layer.effect(
  ExchangeDebugToken,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const exchange =
      yield* firebaseappcheck.exchangeDebugTokenProjectsApps.pipe(
        Effect.provideService(Credentials, credentials),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
    return Effect.fn(function* (debugToken: AppsDebugToken) {
      const app = yield* debugToken.app;
      const secret = yield* debugToken.token;
      return Effect.fn(
        `GCP.Firebaseappcheck.ExchangeDebugToken(${debugToken.LogicalId})`,
      )(function* (request?: ExchangeDebugTokenRequest) {
        return yield* exchange({
          app: yield* app,
          body: {
            debugToken: (yield* secret) ?? "",
            limitedUse: request?.limitedUse === true ? true : undefined,
          },
        });
      });
    });
  }),
);
