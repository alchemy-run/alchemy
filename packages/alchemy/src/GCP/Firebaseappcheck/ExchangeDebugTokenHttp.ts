import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as firebaseappcheck from "@distilled.cloud/gcp/firebaseappcheck_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { AppsDebugToken } from "./AppsDebugToken.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
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
    const exchange = yield* firebaseappcheck.exchangeDebugTokenProjectsApps;
    return Effect.fn(function* (debugToken: AppsDebugToken) {
      yield* bindGcpHost({
        tag: "GCP.Firebaseappcheck.ExchangeDebugToken",
        resource: debugToken,
        iam: [
          { role: defaultRoleFor("GCP.Firebaseappcheck.ExchangeDebugToken") },
        ],
      });
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
